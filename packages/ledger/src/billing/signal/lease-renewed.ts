import { and, eq } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import type { BillingEvent, BillingSignalResult } from '../types.js';
import { leaseUntil } from '../quote.js';

/** lease.renewed 事件（判别收窄后的精确类型） */
export type LeaseRenewedEvent = Extract<BillingEvent, { type: 'lease.renewed' }>;

/**
 * lease.renewed：in_flight 续租（长流按周期续，owner 校验——只有持有租约者能续）。
 * 未命中（非 in_flight / owner 不符 / 租约已被回收转移）返回 undefined 交由编排层回读。
 */
export async function applyLeaseRenewed(
  db: Db,
  now: Date,
  event: LeaseRenewedEvent,
): Promise<BillingSignalResult | undefined> {
  const changed = await db
    .update(billingRequests)
    .set({ leaseExpiresAt: leaseUntil(now, event.leaseMs), updatedAt: now })
    .where(
      and(
        eq(billingRequests.requestId, event.requestId),
        eq(billingRequests.status, 'in_flight'),
        eq(billingRequests.leaseOwner, event.leaseOwner),
      ),
    )
    .returning({ status: billingRequests.status });
  if (changed.length > 0) return { changed: true, status: 'in_flight', replayed: false };
  return undefined;
}
