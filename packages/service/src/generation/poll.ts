/**
 * 生成任务轮询用例（video/music 终态的 worker 侧驱动，v1 语义重写）：
 *
 *   ① 超时扫描   expires_at 到期的在途任务 → CAS expired + request.failed 释放（不扣）
 *   ② task_poll  上游状态查询：running → queued/running 同步 + lease.renewed（防
 *                settlement recover 误释放）；succeeded → CAS 终态 + request.succeeded
 *                （收据=模板填 unitsSnapshot——结算金额 = unitPrice × units 单一公式）；
 *                failed → CAS 终态 + request.failed 释放
 *   ③ task_execute 同步阻塞型上游由 worker 代执行（网关只登记不调上游）
 *
 * 资金语义（两阶段账本的任务形态）：提交时网关只 authorize 预留；本用例的终态信号
 * 驱动实扣（succeeded）或释放（failed/expired）。幂等靠任务行 CAS（0 行命中 = 他副本
 * 已终态化）+ billing signal 的状态机守卫；信号失败只记日志不回滚（任务已终态化，
 * billing 侧租约到期由 settlement recover 按崩溃口径释放——安全网）。
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import { GENERATION_KINDS, isGenerationTaskKind, type UsageReceipt } from '@ai-gateway/domain';
import type { BillingEvent, BillingSignalResult } from '../billing/signal.js';
import type { RunContext } from '../context.js';
import { readOnly } from '../context.js';
import type { GenerationTaskRow } from '@ai-gateway/repository';
import type { GenerationTaskPort, TaskExecuteResult, TaskQueryResult } from './port.js';

export interface GenerationPollConfig {
  /** 单轮各段（超时/轮询/执行）的批量上界 */
  batch: number;
  /** 续租下限 ms（须 ≥ 2× 轮询间隔——装配按节奏计算传入） */
  leaseMs: number;
  /** 超时释放原因（落 fail_reason 与 failure_code 词汇） */
  expireReason: string;
}

export interface GenerationPollResult {
  expired: number;
  polled: number;
  executed: number;
  succeeded: number;
  failed: number;
}

export interface GenerationPollDeps {
  db: Db;
  taskPort: GenerationTaskPort;
  /** billing.signal（四事件入口——worker 装配 billing 域注入） */
  signal: (ctx: RunContext, event: BillingEvent) => Promise<BillingSignalResult>;
  config: GenerationPollConfig;
  repos?: Repositories;
  /** 单任务异常只记日志不中断整轮（默认 console.error） */
  onError?: (error: unknown, context: string) => void;
}

/** 收据模板填 units 即成完整收据（价格快照提交时定型——不让 worker 反解 quote） */
function receiptOf(task: GenerationTaskRow, durationMs: number): UsageReceipt {
  const template = task.receiptTemplate as unknown as UsageReceipt;
  const units = Number(task.unitsSnapshot ?? '1') || 1;
  return { ...template, usage: { ...template.usage, units }, durationMs };
}

export function createGenerationPollUseCase(deps: GenerationPollDeps) {
  const repos = deps.repos ?? createRepositories();
  const noteError = deps.onError ?? ((error, context) => console.error(`[generation] ${context}:`, error));

  /** 续租：锚定任务 expires_at + 宽限，下限 config.leaseMs（防 recover 误释放存活任务） */
  async function renewLease(ctx: RunContext, task: GenerationTaskRow): Promise<void> {
    const graceMs = Math.max(task.expiresAt.getTime() - Date.now() + 30_000, deps.config.leaseMs);
    await deps.signal(ctx, {
      type: 'lease.renewed',
      requestId: task.requestId,
      leaseOwner: task.requestId,
      leaseMs: graceMs,
    });
  }

  /** 终态结算：先信号后终态——信号（实扣）是权威动作，失败保留任务行下轮重试
   *  （上游任务查询幂等 + 信号指纹幂等）；billing 已入结算态则跳过信号直接终态化
   *  （信号已落地、终态 CAS 输给崩溃窗口的自愈路径）。旧序（先终态后信号）
   *  信号失败即永久免费交付产物——顺序倒置后收费永不被吞。 */
  async function settleSucceeded(ctx: RunContext, task: GenerationTaskRow, result: Record<string, unknown>): Promise<boolean> {
    const c = readOnly(ctx, deps.db);
    const status = await repos.billingRequest.currentStatus(c, task.requestId);
    if (status !== 'settlement_pending' && status !== 'settled') {
      try {
        await deps.signal(ctx, {
          type: 'request.succeeded',
          requestId: task.requestId,
          receipt: receiptOf(task, Date.now() - task.createdAt.getTime()),
        });
      } catch (error) {
        noteError(error, `settle signal failed task=${task.id}`);
        return false; // 不终态化：下轮重试信号——宁可晚交付，不可漏收费
      }
    }
    return repos.generationTask.casTerminal(c, { id: task.id, status: 'succeeded', result });
  }

  /** 终态释放（failed/expired）：CAS 成功才发信号 */
  async function settleFailed(ctx: RunContext, task: { id: string; requestId: string }, reason: string): Promise<boolean> {
    const c = readOnly(ctx, deps.db);
    if (!(await repos.generationTask.casTerminal(c, { id: task.id, status: 'failed', failReason: reason.slice(0, 512) }))) {
      return false;
    }
    try {
      await deps.signal(ctx, { type: 'request.failed', requestId: task.requestId, reason: reason.slice(0, 64) });
    } catch (error) {
      noteError(error, `release signal failed task=${task.id}`);
    }
    return true;
  }

  return async function pollGenerationTasks(ctx: RunContext): Promise<GenerationPollResult> {
    const c = readOnly(ctx, deps.db);
    const result: GenerationPollResult = { expired: 0, polled: 0, executed: 0, succeeded: 0, failed: 0 };

    // ---- ① 超时扫描（权威时间源：expires_at ≤ 库端时钟）----
    const expired = await repos.generationTask.expireOverdue(c, { reason: deps.config.expireReason });
    result.expired = expired.length;
    for (const row of expired) {
      try {
        await deps.signal(ctx, { type: 'request.failed', requestId: row.requestId, reason: 'generation_task_expired' });
      } catch (error) {
        noteError(error, `expire signal failed task=${row.id}`);
      }
    }

    // ---- ② task_poll 族：轮询上游状态（游标翻页到短批——首屏饥饿防线）----
    const pollKinds = Object.values(GENERATION_KINDS)
      .filter((d) => d.execution === 'task_poll')
      .map((d) => d.kind);
    for (let cursor: string | undefined, guard = 0; guard < 100; guard++) {
      const pollTasks = await repos.generationTask.listActiveByKinds(c, {
        kinds: pollKinds, statuses: ['queued', 'running'], batch: deps.config.batch,
        ...(cursor ? { afterCreatedAt: cursor } : {}),
      });
      if (pollTasks.length === 0) break;
      cursor = pollTasks[pollTasks.length - 1]!.createdAt.toISOString();
        for (const task of pollTasks) {
          result.polled += 1;
          if (!task.upstreamTaskId) continue;
          const channel = await repos.channel.findTaskChannel(c, task.channelId);
          if (!channel) {
            noteError(new Error('channel missing'), `poll task=${task.id} channel=${task.channelId}`);
            continue;
          }
          let probe: TaskQueryResult;
          try {
            probe = await deps.taskPort.queryTask(channel, task.upstreamTaskId);
          } catch (error) {
            noteError(error, `query task=${task.id}`);
            probe = { ok: false, error: { code: 'query_threw', message: 'task query threw' } };
          }
          if (!probe.ok) {
            await renewLease(ctx, task).catch((e) => noteError(e, `renew task=${task.id}`)); // 瞬时错误：下轮再查
            continue;
          }
          if (probe.status === 'running') {
            if (task.status === 'queued') await repos.generationTask.markRunning(c, task.id);
            await renewLease(ctx, task).catch((e) => noteError(e, `renew task=${task.id}`));
            continue;
          }
          if (probe.status === 'failed') {
            if (await settleFailed(ctx, task, probe.reason ?? 'upstream task failed')) result.failed += 1;
            continue;
          }
          if (probe.status === 'succeeded' && (await settleSucceeded(ctx, task, probe.artifact))) {
            result.succeeded += 1;
          }
        }
        if (pollTasks.length < deps.config.batch) break;
      }

    // ---- ③ task_execute 族：worker 代执行（网关只登记不调上游）----
    const executeKinds = Object.values(GENERATION_KINDS)
      .filter((d) => d.execution === 'task_execute')
      .map((d) => d.kind);
    const executeTasks = await repos.generationTask.listActiveByKinds(c, {
      kinds: executeKinds, statuses: ['queued'], batch: deps.config.batch,
    });
    for (const task of executeTasks) {
      result.executed += 1;
      const channel = await repos.channel.findTaskChannel(c, task.channelId);
      if (!channel) {
        noteError(new Error('channel missing'), `execute task=${task.id} channel=${task.channelId}`);
        continue;
      }
      const template = task.receiptTemplate as unknown as UsageReceipt;
      let outcome: TaskExecuteResult;
      try {
        if (!isGenerationTaskKind(task.kind)) {
          // 插入路径经 descriptor 校验，未知 kind = 数据腐化——响亮失败优于静默错配
          throw new Error(`unknown generation task kind: ${task.kind}`);
        }
        outcome = await deps.taskPort.executeTask(channel, {
          taskId: task.id,
          realModel: template.realModel,
          kind: task.kind,
          params: task.params,
        });
      } catch (error) {
        noteError(error, `execute task=${task.id}`);
        outcome = { ok: false, error: { code: 'execute_threw', message: 'task execution threw' } };
      }
      if (outcome.ok && (await settleSucceeded(ctx, task, outcome.artifact))) {
        result.succeeded += 1;
      } else if (!outcome.ok && (await settleFailed(ctx, task, outcome.error.message ?? 'generation execution failed'))) {
        result.failed += 1;
      }
    }

    return result;
  };
}
