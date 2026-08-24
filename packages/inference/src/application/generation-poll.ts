/**
 * 生成任务轮询用例（v1 service/generation/poll.ts 212 行语义平移；worker app
 * 提供节奏与 billing signal 桥，本用例拥有状态机推进规则）：
 *
 *   ① 超时扫描   expires_at 到期的在途任务 → CAS expired + request_failed 释放（不扣）
 *   ② task_poll  上游状态查询：running → queued/running 同步 + lease_renewed（防
 *                settlement recover 误释放）；succeeded → 信号 + CAS 终态
 *                （收据 = 模板填 unitsSnapshot——结算金额 = unitPrice × units 单一公式）；
 *                failed → CAS 终态 + request_failed 释放
 *   ③ task_execute 同步阻塞型上游由 worker 代执行（网关只登记不调上游）
 *
 * 资金不变量（顺序即语义，v1 §4.3 对位）：
 *   succeeded = 先信号后终态——信号（实扣）是权威动作，失败保留任务行下轮重试
 *   （上游查询幂等 + 信号指纹幂等）——「宁可晚交付，不可漏收费」；billing 已
 *   入结算态（settlement_pending/settled）则跳过信号直接终态化（信号已落地、
 *   终态 CAS 输给崩溃窗口的自愈路径）。旧序（先终态后信号）信号失败即永久
 *   免费交付产物。
 *   failed/expired = 先终态后信号（释放路径相反）——信号失败只记日志不回滚
 *   （任务已终态化，billing 侧租约到期由 settlement recover 按崩溃口径释放）。
 */
import { UpstreamError } from '@tillgate/ai';
import { GENERATION_KINDS } from '../domain/generation';
import type { UsageReceipt } from '../domain/usage/receipt';
import type { BillingSignal } from '../ports/billing';
import type { GenerationTaskActiveRow, GenerationTaskStore } from '../ports/generation';
import type { ChannelCandidate } from '../domain/model/types';
import type { UpstreamPort } from '../ports/upstream';

export interface GenerationPollConfig {
  /** 单轮各段（超时/轮询/执行）的批量上界 */
  batch: number;
  /** 续租下限 ms（须 ≥ 2× 轮询间隔——装配按节奏计算传入） */
  leaseMs: number;
  /** 超时释放原因（落 fail_reason 与 failure_code 词汇） */
  expireReason: string;
  /** 代执行（task_execute）上游调用总预算 ms */
  executeDeadlineMs: number;
  /** 代执行同渠道重试次数（v1 maxRetries=2 对位） */
  executeMaxRetries: number;
}

export interface GenerationPollResult {
  expired: number;
  polled: number;
  executed: number;
  succeeded: number;
  failed: number;
}

export interface GenerationPollDeps {
  tasks: GenerationTaskStore;
  upstream: UpstreamPort;
  /** billing 四事件信号（worker 装配桥接 billing signal——蛇形词表经桥映射） */
  signal: (input: BillingSignal) => Promise<void>;
  /** billing_requests 当前状态（succeeded 自愈路径；null = 行不存在） */
  billingStatus: (requestId: string) => Promise<string | null>;
  /** 渠道连接信息查找（worker 装配桥接 control-plane findTaskChannel） */
  findChannel: (channelId: number) => Promise<ChannelCandidate | null>;
  config: GenerationPollConfig;
  /** 单任务异常只记日志不中断整轮 */
  onError?: (error: unknown, context: string) => void;
}

/** 收据模板填 units 即成完整收据（价格快照提交时定型——不让 worker 反解 quote） */
function receiptOf(task: GenerationTaskActiveRow, durationMs: number): UsageReceipt {
  const template = task.receiptTemplate;
  const units = task.unitsSnapshot || 1;
  return { ...template, usage: { ...template.usage, units }, durationMs };
}

/** 续租宽限常数（v1 同值）：expires_at 余量 + 30s，下限 config.leaseMs */
const LEASE_GRACE_MS = 30_000;

/** 单任务异常记录面（缺省 console；worker 装配注入结构化日志） */
type NoteError = (error: unknown, context: string) => void;

/** 轮询上下文：依赖 + 错误记录面（三个族函数共用） */
interface PollCtx {
  deps: GenerationPollDeps;
  noteError: NoteError;
}

/** 续租：锚定任务 expires_at + 宽限，下限 config.leaseMs（防 recover 误释放存活任务） */
async function renewLease(ctx: PollCtx, task: GenerationTaskActiveRow): Promise<void> {
  const graceMs = Math.max(task.expiresAt - Date.now() + LEASE_GRACE_MS, ctx.deps.config.leaseMs);
  await ctx.deps.signal({
    type: 'lease_renewed',
    requestId: task.requestId,
    leaseOwner: task.requestId,
    leaseMs: graceMs,
  });
}

/** 终态结算：先信号后终态（顺序即防漏收费不变量——见文件头） */
async function settleSucceeded(
  ctx: PollCtx,
  args: { task: GenerationTaskActiveRow; result: Record<string, unknown> },
): Promise<boolean> {
  const { task, result } = args;
  const status = await ctx.deps.billingStatus(task.requestId);
  if (status !== 'settlement_pending' && status !== 'settled') {
    try {
      await ctx.deps.signal({
        type: 'request_succeeded',
        requestId: task.requestId,
        receipt: receiptOf(task, Date.now() - task.createdAt),
      });
    } catch (error) {
      ctx.noteError(error, `settle signal failed task=${task.taskId}`);
      return false; // 不终态化：下轮重试信号——宁可晚交付，不可漏收费
    }
  }
  return await ctx.deps.tasks.casTerminal({ taskId: task.taskId, status: 'succeeded', result });
}

/** 终态释放（failed/expired）：CAS 成功才发信号（释放顺序与 succeeded 相反） */
async function settleFailed(
  ctx: PollCtx,
  args: { task: { taskId: string; requestId: string }; reason: string },
): Promise<boolean> {
  const { task, reason } = args;
  if (
    !(await ctx.deps.tasks.casTerminal({
      taskId: task.taskId,
      status: 'failed',
      failReason: reason.slice(0, 512),
    }))
  ) {
    return false;
  }
  try {
    await ctx.deps.signal({
      type: 'request_failed',
      requestId: task.requestId,
      reason: reason.slice(0, 64),
    });
  } catch (error) {
    ctx.noteError(error, `release signal failed task=${task.taskId}`);
  }
  return true;
}

/** ① 超时扫描（权威时间源：expires_at ≤ 存储端时钟）：CAS expired + request_failed 释放（不扣） */
async function expireScan(ctx: PollCtx): Promise<number> {
  const expired = await ctx.deps.tasks.expireOverdue(ctx.deps.config.expireReason);
  for (const row of expired) {
    try {
      await ctx.deps.signal({
        type: 'request_failed',
        requestId: row.requestId,
        reason: 'generation_task_expired',
      });
    } catch (error) {
      ctx.noteError(error, `expire signal failed task=${row.taskId}`);
    }
  }
  return expired.length;
}

/** ② 单任务轮询推进：返回终态计数（undefined = 无终态推进） */
// eslint-disable-next-line max-lines-per-function -- 单任务轮询循环:重构后位于 50 行边界,oxfmt 换行推超 1 行
async function pollSingleTask(
  ctx: PollCtx,
  task: GenerationTaskActiveRow,
): Promise<'succeeded' | 'failed' | undefined> {
  if (!task.upstreamTaskId) return undefined;
  const channel = await ctx.deps.findChannel(task.channelId);
  if (!channel) {
    ctx.noteError(
      new Error('channel missing'),
      `poll task=${task.taskId} channel=${task.channelId}`,
    );
    return undefined;
  }
  let probe: Awaited<ReturnType<typeof ctx.deps.upstream.queryTask>>;
  try {
    probe = await ctx.deps.upstream.queryTask(channel, task.upstreamTaskId);
  } catch (error) {
    ctx.noteError(error, `query task=${task.taskId}`);
    probe = {
      ok: false,
      error: new UpstreamError({ kind: 'network', message: 'task query threw' }),
    };
  }
  if (!probe.ok) {
    await renewLease(ctx, task).catch((error) => ctx.noteError(error, `renew task=${task.taskId}`)); // 瞬时错误：下轮再查
    return undefined;
  }
  if (probe.status === 'running') {
    if (task.status === 'queued') await ctx.deps.tasks.markRunning(task.taskId);
    await renewLease(ctx, task).catch((error) => ctx.noteError(error, `renew task=${task.taskId}`));
    return undefined;
  }
  if (probe.status === 'failed') {
    return (await settleFailed(ctx, {
      task,
      reason: probe.reason ?? 'upstream task failed',
    }))
      ? 'failed'
      : undefined;
  }
  if (
    probe.status === 'succeeded' &&
    (await settleSucceeded(ctx, {
      task,
      result: (probe.artifact ?? {}) as Record<string, unknown>,
    }))
  ) {
    return 'succeeded';
  }
  return undefined;
}

/** ② task_poll 族：轮询上游状态（游标翻页到短批——首屏饥饿防线） */
async function pollTaskFamily(
  ctx: PollCtx,
): Promise<{ polled: number; succeeded: number; failed: number }> {
  const acc = { polled: 0, succeeded: 0, failed: 0 };
  const pollKinds = Object.values(GENERATION_KINDS)
    .filter((d) => d.execution === 'task_poll')
    .map((d) => d.kind);
  for (let cursor: number | undefined, guard = 0; guard < 100; guard++) {
    const pollTasks = await ctx.deps.tasks.listActive({
      kinds: pollKinds,
      statuses: ['queued', 'running'],
      batch: ctx.deps.config.batch,
      ...(cursor != null ? { afterCreatedAt: cursor } : {}),
    });
    if (pollTasks.length === 0) break;
    const lastTask = pollTasks.at(-1);
    // 不可达守卫:length > 0 时 at(-1) 必存在,仅做类型收窄
    if (lastTask == null) break;
    cursor = lastTask.createdAt;
    for (const task of pollTasks) {
      acc.polled += 1;
      const outcome = await pollSingleTask(ctx, task);
      if (outcome != null) acc[outcome] += 1;
    }
    if (pollTasks.length < ctx.deps.config.batch) break;
  }
  return acc;
}

/** ③ 单任务代执行：同步阻塞型上游调用（异常归一 network 错误）→ 终态推进 */
async function executeSingleTask(
  ctx: PollCtx,
  task: GenerationTaskActiveRow,
  channel: ChannelCandidate,
): Promise<'succeeded' | 'failed' | undefined> {
  let outcome: Awaited<ReturnType<typeof ctx.deps.upstream.executeTask>>;
  try {
    outcome = await ctx.deps.upstream.executeTask(channel, task.kind, {
      requestId: task.taskId,
      externalModel: task.receiptTemplate.externalModel,
      realModel: task.receiptTemplate.realModel,
      endpoint: task.kind,
      body: task.params,
      deadlineMs: ctx.deps.config.executeDeadlineMs,
      maxRetries: ctx.deps.config.executeMaxRetries,
    });
  } catch (error) {
    ctx.noteError(error, `execute task=${task.taskId}`);
    outcome = {
      ok: false,
      error: new UpstreamError({ kind: 'network', message: 'task execution threw' }),
    };
  }
  if (outcome.ok && (await settleSucceeded(ctx, { task, result: outcome.artifact }))) {
    return 'succeeded';
  }
  if (
    !outcome.ok &&
    (await settleFailed(ctx, {
      task,
      reason: outcome.error.message ?? 'generation execution failed',
    }))
  ) {
    return 'failed';
  }
  return undefined;
}

/** ③ task_execute 族：worker 代执行（网关只登记不调上游；单批无翻页） */
async function executeTaskFamily(
  ctx: PollCtx,
): Promise<{ executed: number; succeeded: number; failed: number }> {
  const acc = { executed: 0, succeeded: 0, failed: 0 };
  const executeKinds = Object.values(GENERATION_KINDS)
    .filter((d) => d.execution === 'task_execute')
    .map((d) => d.kind);
  const executeTasks = await ctx.deps.tasks.listActive({
    kinds: executeKinds,
    statuses: ['queued'],
    batch: ctx.deps.config.batch,
  });
  for (const task of executeTasks) {
    acc.executed += 1;
    const channel = await ctx.deps.findChannel(task.channelId);
    if (!channel) {
      ctx.noteError(
        new Error('channel missing'),
        `execute task=${task.taskId} channel=${task.channelId}`,
      );
      continue;
    }
    const outcome = await executeSingleTask(ctx, task, channel);
    if (outcome != null) acc[outcome] += 1;
  }
  return acc;
}

export function createGenerationPollUseCase(deps: GenerationPollDeps) {
  const ctx: PollCtx = {
    deps,
    noteError:
      deps.onError ?? ((error, context) => console.error(`[generation] ${context}:`, error)),
  };
  return async function pollGenerationTasks(): Promise<GenerationPollResult> {
    const expired = await expireScan(ctx);
    const polled = await pollTaskFamily(ctx);
    const executed = await executeTaskFamily(ctx);
    return {
      expired,
      polled: polled.polled,
      executed: executed.executed,
      succeeded: polled.succeeded + executed.succeeded,
      failed: polled.failed + executed.failed,
    };
  };
}
