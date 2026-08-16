import { eq } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import type { BillingEvent, BillingSignalResult } from '../types.js';
import { BillingStateConflictError } from '../errors.js';
import { applyUpstreamStarted } from './upstream-started.js';
import { applyLeaseRenewed } from './lease-renewed.js';
import { applyRequestSucceeded } from './request-succeeded.js';
import { applyRequestFailed } from './request-failed.js';

/**
 * 账单状态机事件编排（对外唯一入口，billing.ts 消费）：
 *
 *   upstream.started  → signal/upstream-started.ts   authorized → in_flight（起租约）
 *   lease.renewed     → signal/lease-renewed.ts      in_flight 续租（owner 校验）
 *   request.succeeded → signal/request-succeeded.ts  落 durable receipt → settlement_pending
 *   request.failed    → signal/request-failed.ts     释放 + 三类预扣投影同步归还
 *
 * 各处理器返回 undefined = 未命中转移，统一落到本文件的共享尾部：回读现状判定
 * （started 非 in_flight 抛冲突；其余幂等重放）。switch 穷尽四事件，default 的
 * never 检查让新增 BillingEvent 变体而漏写转移成为编译期错误。
 */
export async function signalEvent(
  db: Db,
  clock: () => Date,
  event: BillingEvent,
): Promise<BillingSignalResult> {
  const now = clock();
  switch (event.type) {
    case 'upstream.started':
      return (await applyUpstreamStarted(db, now, event)) ?? replayAfterMiss(db, event);
    case 'lease.renewed':
      return (await applyLeaseRenewed(db, now, event)) ?? replayAfterMiss(db, event);
    case 'request.succeeded':
      return applyRequestSucceeded(db, now, event);
    case 'request.failed':
      return (await applyRequestFailed(db, now, event)) ?? replayAfterMiss(db, event);
    default: {
      // 穷尽性检查：新增事件类型而漏写转移 → 编译期报错
      const exhaustive: never = event;
      throw new Error(`unhandled billing event: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 未命中转移的共享尾部：回读现状——started 语义严格（非 in_flight 抛冲突），其余幂等重放 */
async function replayAfterMiss(
  db: Db,
  event: BillingEvent,
): Promise<BillingSignalResult> {
  const existing = await db.query.billingRequests.findFirst({
    where: eq(billingRequests.requestId, event.requestId),
    columns: { status: true },
  });
  if (!existing)
    throw new BillingStateConflictError(event.requestId, 'billing request missing');
  if (event.type === 'upstream.started' && existing.status !== 'in_flight') {
    throw new BillingStateConflictError(
      event.requestId,
      `upstream start rejected in billing state ${existing.status}`,
    );
  }
  return { changed: false, status: existing.status, replayed: true };
}
