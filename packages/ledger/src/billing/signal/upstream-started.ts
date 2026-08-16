import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import type { BillingEvent, BillingSignalResult } from '../types.js';
import { leaseUntil } from '../quote.js';

/** upstream.started 事件（判别收窄后的精确类型） */
export type UpstreamStartedEvent = Extract<BillingEvent, { type: 'upstream.started' }>;

/**
 * upstream.started：authorized → in_flight（起租约，覆盖整个请求预算）。
 * 幂等语义：已在 in_flight 可重复发（重试路径重放）；命中转移返回结果，
 * 未命中（行不存在/已终态）返回 undefined 交由编排层回读现状判定。
 */
export async function applyUpstreamStarted(
  db: Db,
  now: Date,
  event: UpstreamStartedEvent,
): Promise<BillingSignalResult | undefined> {
  const changed = await db
    .update(billingRequests)
    .set({
      status: 'in_flight',
      revision: sql`${billingRequests.revision} + 1`,
      leaseOwner: event.leaseOwner,
      leaseExpiresAt: leaseUntil(now, event.leaseMs),
      upstreamStartedAt: sql`coalesce(${billingRequests.upstreamStartedAt}, ${now})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(billingRequests.requestId, event.requestId),
        inArray(billingRequests.status, ['authorized', 'in_flight']),
      ),
    )
    .returning({ status: billingRequests.status });
  if (changed.length > 0) return { changed: true, status: 'in_flight', replayed: false };
  return undefined;
}
