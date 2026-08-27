/**
 * 单轮告警投递:
 * 轮首取活跃渠道快照一次 → 认领一次一行(独立事务,防整批排队租约未执行就过期)→
 * 订阅+进度过滤 → 并行投递 → 渠道进度 CAS → 全成功终态/否则退避失败。
 * 租约过期:进度/终态 CAS 返回 false 只告警不计数,行等待重领(fencing 保证不重发)。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@tillgate/db';
import type { NotifyStore } from '../ports/notify-store';
import type { EmailSender } from '../ports/email-sender';
import type { WebhookDeliverer } from '../ports/webhook-deliverer';
import type { SecretCipher } from '../ports/secret-cipher';
import { selectTargetChannels, succeededChannelIds, backoffDelayMs } from '../domain/delivery';
import { deliverToChannel } from './deliver-to-channel';
import { systemContext, type NotifyContext } from './context';
export interface DispatchConfig {
  /** 单行认领租约;须覆盖 webhookTimeoutMs 与 SMTP 投递上界(装配层约束) */
  readonly claimLeaseMs: number;
  /** 投递尝试上限(达上限终态 failed) */
  readonly maxAttempts: number;
  /** 单轮最多处理行数 */
  readonly loopBatchLimit: number;
  readonly webhookTimeoutMs: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly emailBrand: string;
}

export interface DispatchDeps {
  readonly db: Db;
  readonly store: NotifyStore;
  readonly cipher: SecretCipher;
  /** 缺省 undefined = email 渠道 fail-closed */
  readonly emailSender?: EmailSender;
  readonly webhookDeliverer: WebhookDeliverer;
  readonly config: DispatchConfig;
  readonly logger: { warn(obj: unknown, msg: string): void };
}

export interface DispatchOnceInput {
  readonly ctx?: NotifyContext;
  /** 认领者标识(缺省 per-run 随机——多副本互斥由 DB 认领保证) */
  readonly ownerId?: string;
}

export interface DispatchResult {
  readonly sent: number;
  readonly failed: number;
}

/** 认领到的待投递行(store 契约推导) */
type ClaimedRow = Awaited<ReturnType<NotifyStore['claimPending']>>[number];
/** 活跃渠道快照 */
type ChannelSnapshot = Awaited<ReturnType<NotifyStore['listChannels']>>;

/** 单行处理上下文(fencing 三元组 + 告警关联) */
interface ItemScope {
  item: ClaimedRow;
  ownerId: string;
  ctx: NotifyContext;
}

/** 同一事件的渠道并行投递:租约上界只受最慢渠道影响;单渠道失败收敛为 false */
async function deliverInParallel(
  deps: DispatchDeps,
  matched: ReturnType<typeof selectTargetChannels>,
  item: ClaimedRow,
): Promise<boolean[]> {
  return Promise.all(
    matched.map((channel) =>
      deliverToChannel(
        {
          cipher: deps.cipher,
          ...(deps.emailSender !== undefined ? { emailSender: deps.emailSender } : {}),
          webhookDeliverer: deps.webhookDeliverer,
          emailBrand: deps.config.emailBrand,
        },
        {
          deliveryId: `${item.id}:${channel.id}`,
          channelType: channel.type,
          config: channel.config,
          event: item.event,
          payload: item.payload,
        },
      ).catch(() => false),
    ),
  );
}

/**
 * 投递后结算:全成功 → 终态(计 sent);否则退避失败(计 failed)。
 * 租约过期:CAS 返回 false 只告警不计数,行等待重领(fencing 保证不重发)。
 */
async function settleClaimedItem(
  deps: DispatchDeps,
  scope: ItemScope,
  outcomes: boolean[],
): Promise<'sent' | 'failed' | null> {
  const { item, ownerId, ctx } = scope;
  if (outcomes.every(Boolean)) {
    const completed = await deps.db.transaction((tx) =>
      deps.store.completeClaim(tx, { id: item.id, ownerId, claimToken: item.claimToken }),
    );
    if (completed) return 'sent';
    deps.logger.warn(
      { outboxId: item.id, ownerId, requestId: ctx.requestId },
      'notify claim expired before completion',
    );
    return null;
  }
  const recorded = await deps.db.transaction((tx) =>
    deps.store.failClaim(tx, {
      id: item.id,
      ownerId,
      claimToken: item.claimToken,
      maxAttempts: deps.config.maxAttempts,
      error: 'delivery failed',
      retryDelayMs: backoffDelayMs(item.attempts, {
        baseMs: deps.config.backoffBaseMs,
        capMs: deps.config.backoffCapMs,
      }),
    }),
  );
  if (recorded) return 'failed';
  deps.logger.warn(
    { outboxId: item.id, ownerId, requestId: ctx.requestId },
    'notify claim expired before failure recording',
  );
  return null;
}

/**
 * 单行处理:订阅过滤 → 并行投递 → 进度 CAS → 结算。
 * 无订阅渠道直接终态化(不再重扫);进度 CAS 过期只告警。
 */
async function processClaimedItem(
  deps: DispatchDeps,
  scope: ItemScope,
  channels: ChannelSnapshot,
): Promise<'sent' | 'failed' | null> {
  const { item, ownerId, ctx } = scope;
  const matched = selectTargetChannels(channels, {
    event: item.event,
    deliveredChannelIds: item.deliveredChannelIds,
  });
  if (matched.length === 0) {
    // 无订阅渠道:终态化(不再重扫)
    await deps.db.transaction((tx) =>
      deps.store.completeClaim(tx, { id: item.id, ownerId, claimToken: item.claimToken }),
    );
    return null;
  }

  const outcomes = await deliverInParallel(deps, matched, item);
  const succeeded = succeededChannelIds(matched, outcomes);
  const progressRecorded = await deps.db.transaction((tx) =>
    deps.store.recordDeliveredChannels(tx, {
      id: item.id,
      ownerId,
      claimToken: item.claimToken,
      channelIds: succeeded,
    }),
  );
  if (!progressRecorded) {
    deps.logger.warn(
      { outboxId: item.id, ownerId, requestId: ctx.requestId },
      'notify claim expired before progress recording',
    );
    return null;
  }
  return settleClaimedItem(deps, scope, outcomes);
}

export async function dispatchOnce(
  deps: DispatchDeps,
  input: DispatchOnceInput = {},
): Promise<DispatchResult> {
  const { config } = deps;
  const ownerId = input.ownerId ?? `notify-${process.pid}-${randomUUID()}`;
  const ctx = input.ctx ?? systemContext(`notify-dispatch:${ownerId}`);

  // 渠道快照轮首一次:轮中渠道变更下一轮生效
  const channels = await deps.store.listChannels(deps.db, { activeOnly: true });

  let sent = 0;
  let failed = 0;
  for (let processed = 0; processed < config.loopBatchLimit; processed += 1) {
    const claimed = await deps.db.transaction((tx) =>
      deps.store.claimPending(tx, {
        ownerId,
        limit: 1,
        leaseMs: config.claimLeaseMs,
        maxAttempts: config.maxAttempts,
      }),
    );
    // 认领一次一行(独立事务,防整批排队租约未执行就过期)
    const [item] = claimed;
    if (!item) break;

    const outcome = await processClaimedItem(deps, { item, ownerId, ctx }, channels);
    if (outcome === 'sent') sent += 1;
    if (outcome === 'failed') failed += 1;
  }
  return { sent, failed };
}
