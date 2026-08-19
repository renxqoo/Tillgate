import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { channels, generationTasks, providers } from '@ai-gateway/db/schema';
import { decrypt } from '@ai-gateway/core';
import type { Logger } from '@ai-gateway/core';
import {
  GENERATION_KINDS,
  type Ai,
  type ChannelDesc,
  type GenerationArtifact,
  type GenerationKind,
} from '@ai-gateway/ai';
import type { UsageReceipt } from '@ai-gateway/ledger';
import type { BillingDomain } from '@ai-gateway/ledger/billing';

/**
 * 异步生成任务轮询（video/music，任务生命周期的 worker 侧驱动）：
 *
 *   ① 超时扫描   expires_at 到期的在途任务 → expired + request.failed 释放（不扣）
 *   ② video 轮询 上游状态查询：running → 续租（lease.renewed，防 recoverOnce 误释放）；
 *                 succeeded → 取产物 URL → CAS 终态 + request.succeeded（收据模板填 units）；
 *                 failed → CAS 终态 + request.failed 释放
 *   ③ music 执行 同步阻塞型上游调用由 worker 代执行（网关只登记不调上游）：
 *                 ai.chat(endpoint=music) → 解析产物 → CAS 终态 + 结算/释放
 *
 * 资金语义（两阶段账本的任务形态）：提交时网关只预留；本文件的终态信号驱动
 * 实扣（succeeded）或释放（failed/expired）——幂等靠任务行 CAS（0 行命中 =
 * 他副本已终态化）+ billing signal 的状态机守卫，无「真扣+退款」双轨。
 * 多副本：worker-application 层 advisory lock 串行化整轮，CAS 是兜底。
 */

export interface GenerationPollerDeps {
  db: Db;
  ai: Ai;
  billing: BillingDomain;
  logger: Logger;
  /** 单轮各段（超时/轮询/执行）的批量上界 */
  batch: number;
  /** 续租时长：须 ≥ 2×轮询间隔（由调用方按 env 计算传入） */
  leaseMs: number;
}

export interface GenerationPollResult {
  expired: number;
  polled: number;
  executed: number;
  succeeded: number;
  failed: number;
}

/** 终态 CAS：仅在指定在途状态集合内迁移；0 行 = 他副本已处理（幂等跳过） */
async function casTerminal(
  db: Db,
  id: string,
  patch: { status: 'succeeded' | 'failed' | 'expired'; result?: Record<string, unknown>; failReason?: string },
): Promise<boolean> {
  const changed = await db
    .update(generationTasks)
    .set({
      status: patch.status,
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      ...(patch.failReason !== undefined ? { failReason: patch.failReason } : {}),
      finishedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(generationTasks.id, id),
        inArray(generationTasks.status, ['queued', 'running']),
      ),
    )
    .returning({ id: generationTasks.id });
  return changed.length > 0;
}

/** 渠道描述缓存（单轮内）：解密上游 Key + 关联 provider 名 */
async function channelDescOf(
  db: Db,
  channelId: number,
  encryptionKey: string,
  encryptionKeyOld: string | undefined,
  cache: Map<number, { desc: ChannelDesc; providerName: string }>,
): Promise<{ desc: ChannelDesc; providerName: string } | null> {
  const hit = cache.get(channelId);
  if (hit) return hit;
  const row = await db
    .select({
      baseUrl: channels.baseUrlOverride,
      providerBaseUrl: providers.baseUrl,
      providerName: providers.name,
      protocol: providers.protocol,
      apiKeyEnc: channels.apiKeyEnc,
    })
    .from(channels)
    .innerJoin(providers, eq(channels.providerId, providers.id))
    .where(eq(channels.id, channelId))
    .limit(1);
  if (row.length === 0) return null;
  const r = row[0]!;
  const entry = {
    desc: {
      // baseUrl 覆盖优先（渠道级），否则用 provider 默认
      baseUrl: r.baseUrl ?? r.providerBaseUrl,
      apiKey: decrypt(r.apiKeyEnc, encryptionKey, encryptionKeyOld),
      protocol: r.protocol,
    } satisfies ChannelDesc,
    providerName: r.providerName,
  };
  cache.set(channelId, entry);
  return entry;
}

/** 终态结算信号：收据模板填 units（结算金额 = unitPrice × units × 系数，单一公式） */
async function signalSucceeded(
  deps: GenerationPollerDeps,
  task: { id: string; requestId: string; receiptTemplate: unknown; unitsSnapshot: string | null },
  durationMs: number,
): Promise<void> {
  const template = task.receiptTemplate as unknown as UsageReceipt;
  const receipt: UsageReceipt = {
    ...template,
    usage: { ...template.usage, units: Number(task.unitsSnapshot ?? '1') || 1 },
    durationMs,
  };
  await deps.billing.signal({
    type: 'request.succeeded',
    requestId: task.requestId,
    receipt,
  });
}

/** 终态释放信号（failed/expired）：两阶段账本的释放路径（不扣） */
async function signalFailed(
  deps: GenerationPollerDeps,
  task: { requestId: string },
  reason: string,
): Promise<void> {
  await deps.billing.signal({
    type: 'request.failed',
    requestId: task.requestId,
    reason,
    delivery: 'none',
    upstreamCharge: 'none',
  });
}

export async function runGenerationPollOnce(
  deps: GenerationPollerDeps,
  opts: { encryptionKey: string; encryptionKeyOld?: string },
): Promise<GenerationPollResult> {
  const { db, ai, logger } = deps;
  const result: GenerationPollResult = { expired: 0, polled: 0, executed: 0, succeeded: 0, failed: 0 };
  const channelCache = new Map<number, { desc: ChannelDesc; providerName: string }>();

  // ---- ① 超时扫描（权威时间源：expires_at）----
  const expired = await db
    .update(generationTasks)
    .set({
      status: 'expired',
      failReason: '任务超时（TTL 到期）',
      finishedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        inArray(generationTasks.status, ['queued', 'running']),
        lte(generationTasks.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .returning({ id: generationTasks.id, requestId: generationTasks.requestId });
  result.expired = expired.length;
  for (const row of expired) {
    try {
      await signalFailed(deps, row, 'generation_task_expired');
    } catch (error) {
      // 释放信号失败：任务已终态化（CAS 完成），下轮不再处理——billing 侧
      // in_flight 租约到期由 recoverOnce 崩溃口径释放（安全网），仅记日志。
      logger.warn({ requestId: row.requestId, err: (error as Error).message }, 'generation expire signal failed');
    }
  }

  // ---- ② task_poll 策略：轮询上游状态（video 型执行模型；新类型零分支接入）----
  const pollKinds = Object.values(GENERATION_KINDS)
    .filter((d) => d.execution === 'task_poll')
    .map((d) => d.kind);
  const pollTasks = await db
    .select()
    .from(generationTasks)
    .where(and(inArray(generationTasks.kind, pollKinds), inArray(generationTasks.status, ['queued', 'running'])))
    .orderBy(asc(generationTasks.createdAt))
    .limit(deps.batch);
  for (const task of pollTasks) {
    result.polled += 1;
    if (!task.upstreamTaskId) continue;
    const ch = await channelDescOf(db, task.channelId, opts.encryptionKey, opts.encryptionKeyOld, channelCache);
    if (!ch) {
      logger.warn({ taskId: task.id, channelId: task.channelId }, 'generation channel missing');
      continue;
    }
    if (!ai.queryGenerationTask) {
      logger.warn({ taskId: task.id, protocol: ch.desc.protocol }, 'protocol has no task ops');
      continue;
    }
    const probe = await ai.queryGenerationTask({ channel: ch.desc, taskId: task.upstreamTaskId });
    if (!probe.ok) {
      // 瞬时错误：本轮只续租，下轮再查（轮询节奏即退避）
      await renewLease(deps, task.requestId, task.expiresAt).catch(() => {});
      continue;
    }
    if (probe.status === 'running') {
      // queued → running 状态同步（非终态，无 CAS 竞争问题）
      if (task.status === 'queued') {
        await db
          .update(generationTasks)
          .set({ status: 'running', updatedAt: sql`clock_timestamp()` })
          .where(and(eq(generationTasks.id, task.id), eq(generationTasks.status, 'queued')));
      }
      await renewLease(deps, task.requestId, task.expiresAt).catch(() => {});
      continue;
    }
    if (probe.status === 'failed') {
      const reason = probe.reason ?? 'upstream task failed';
      if (await casTerminal(db, task.id, { status: 'failed', failReason: reason.slice(0, 512) })) {
        result.failed += 1;
        await signalFailed(deps, task, `generation_failed:${reason}`.slice(0, 64));
      }
      continue;
    }
    // succeeded：产物归一形（url 需 files/retrieve 换取的协议在此补齐——统一规则）
    const artifact: GenerationArtifact = probe.artifact !== undefined ? { ...probe.artifact } : {};
    if (artifact.url === undefined && probe.fileId !== undefined) {
      if (!ai.retrieveGenerationFile) continue;
      const file = await ai.retrieveGenerationFile({ channel: ch.desc, fileId: probe.fileId });
      if (!file.ok) {
        await renewLease(deps, task.requestId, task.expiresAt).catch(() => {});
        continue;
      }
      artifact.url = file.downloadUrl;
    }
    const elapsed = Date.now() - task.createdAt.getTime();
    if (
      await casTerminal(db, task.id, {
        status: 'succeeded',
        result: artifact as Record<string, unknown>,
      })
    ) {
      result.succeeded += 1;
      try {
        await signalSucceeded(deps, task, elapsed);
      } catch (error) {
        logger.error({ taskId: task.id, err: (error as Error).message }, 'generation settle signal failed');
      }
    }
  }

  // ---- ③ task_execute 策略：同步阻塞型上游由 worker 代执行（music 型执行模型）----
  const executeKinds = Object.values(GENERATION_KINDS)
    .filter((d) => d.execution === 'task_execute')
    .map((d) => d.kind);
  const executeTasks = await db
    .select()
    .from(generationTasks)
    .where(and(inArray(generationTasks.kind, executeKinds), eq(generationTasks.status, 'queued')))
    .orderBy(asc(generationTasks.createdAt))
    .limit(deps.batch);
  for (const task of executeTasks) {
    result.executed += 1;
    const ch = await channelDescOf(db, task.channelId, opts.encryptionKey, opts.encryptionKeyOld, channelCache);
    if (!ch) {
      logger.warn({ taskId: task.id, channelId: task.channelId }, 'generation channel missing');
      continue;
    }
    const template = task.receiptTemplate as unknown as UsageReceipt;
    const upstream = await ai.chat({
      channel: ch.desc,
      request: task.params,
      ctx: {
        requestId: task.id,
        model: template.realModel,
        providerName: ch.providerName,
        endpoint: task.kind as GenerationKind,
        maxRetries: 2,
      },
    });
    const elapsed = Date.now() - task.createdAt.getTime();
    if (upstream.status === 'success') {
      const parsed = ai.parseGenerationResponse?.({
        channel: ch.desc,
        endpoint: task.kind as 'video' | 'music',
        body: upstream.body,
      });
      if (parsed?.kind === 'task_completed') {
        if (
          await casTerminal(db, task.id, {
            status: 'succeeded',
            result: parsed.artifact as Record<string, unknown>,
          })
        ) {
          result.succeeded += 1;
          try {
            await signalSucceeded(deps, task, elapsed);
          } catch (error) {
            logger.error({ taskId: task.id, err: (error as Error).message }, 'generation settle signal failed');
          }
        }
        continue;
      }
      const reason = parsed?.kind === 'error' ? parsed.error.message : '上游未返回生成产物';
      if (await casTerminal(db, task.id, { status: 'failed', failReason: reason.slice(0, 512) })) {
        result.failed += 1;
        await signalFailed(deps, task, 'generation_failed');
      }
      continue;
    }
    const reason = upstream.error?.message ?? 'generation execution failed';
    if (await casTerminal(db, task.id, { status: 'failed', failReason: reason.slice(0, 512) })) {
      result.failed += 1;
      await signalFailed(deps, task, 'generation_failed');
    }
  }

  return result;
}

/**
 * 续租：租约锚定 expires_at + 30s 宽限（与网关提交时的 TTL 租约同锚点）——
 * 轮询期间租约不缩短（防 recoverOnce 误释放存活任务）；expires_at 之后的
 * 下限 deps.leaseMs 兜底超时扫描与释放信号之间的窗口。
 */
async function renewLease(
  deps: GenerationPollerDeps,
  requestId: string,
  expiresAt: Date,
): Promise<void> {
  const ms = Math.max(expiresAt.getTime() - Date.now() + 30_000, deps.leaseMs);
  await deps.billing.signal({
    type: 'lease.renewed',
    requestId,
    leaseOwner: requestId,
    leaseMs: ms,
  });
}
