import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import type { BillingEvent, BillingSignalResult } from '../types.js';
import { BillingInvariantError } from '../errors.js';
import { releaseReservedAmounts } from '../release.js';

/** request.failed 事件（判别收窄后的精确类型） */
export type RequestFailedEvent = Extract<BillingEvent, { type: 'request.failed' }>;

/**
 * request.failed：释放不扣（2026-08-17 估算结算政策）。
 *
 * authorized/in_flight → released，同一事务内同步释放三类预扣投影
 * （余额在途/套餐在途/渠道在途——唯一实现 release.ts；R1 回归：曾遗漏余额部分
 * 导致 PAYG 预占永久冻结）。upstreamCharge 字段不再分流资金语义（旧口径
 * unknown → uncertain 冻结已随政策删除），仅保留日志/trace 观测用途。
 * 未命中（已终态）返回 undefined 交由编排层回读（幂等重放）。
 */
export async function applyRequestFailed(
  db: Db,
  now: Date,
  event: RequestFailedEvent,
): Promise<BillingSignalResult | undefined> {
  const released = await db.transaction(async (tx) => {
    const row = await tx
      .update(billingRequests)
      .set({
        status: 'released',
        revision: sql`${billingRequests.revision} + 1`,
        failureCode: event.reason.slice(0, 64),
        leaseExpiresAt: null,
        releasedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(billingRequests.requestId, event.requestId),
          inArray(billingRequests.status, ['authorized', 'in_flight']),
        ),
      )
      .returning({
        userId: billingRequests.userId,
        reservedAmount: billingRequests.reservedAmount,
        planReservedAmount: billingRequests.planReservedAmount,
        subscriptionId: billingRequests.subscriptionId,
        channelId: billingRequests.channelId,
        channelReservedAmount: billingRequests.channelReservedAmount,
      });
    if (row.length === 0) return null;
    await releaseReservedAmounts(
      tx,
      row[0]!,
      (dimension) => new BillingInvariantError(`${dimension}_reservation_invariant`),
    );
    return row[0]!;
  });
  if (released) {
    return { changed: true, status: 'released', replayed: false };
  }
  return undefined;
}
