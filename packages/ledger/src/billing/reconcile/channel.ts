import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests, channels, reconcileDiscrepancies } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';

/**
 * 渠道级在途敞口一致性校验：channels.upstream_reserved 必须等于
 * 该渠道所有活跃 billing_requests.channel_reserved_amount 之和（容差 1e-9）。
 * 用于发现 reserve/release 脱节（资损护栏自身的正确性）。
 */
export async function reconcileChannelReserved(db: Db, channelId: number): Promise<boolean> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { upstreamReserved: true },
  });
  if (!channel) return true;
  const activeSum = await db
    .select({
      total: sql<string>`coalesce(sum(${billingRequests.channelReservedAmount}),0)::numeric`,
    })
    .from(billingRequests)
    .where(
      and(
        eq(billingRequests.channelId, channelId),
        inArray(billingRequests.status, [
          // dead 仍持有渠道敞口直到 abandonDead，属合法在途，缺失会造成假差异
          'authorized',
          'in_flight',
          'settlement_pending',
          'processing',
          'retry_wait',
          'dead',
        ]),
      ),
    );
  const expected = new Decimal(activeSum[0]?.total ?? '0');
  const actual = new Decimal(channel.upstreamReserved);
  const diff = actual.minus(expected);
  if (diff.abs().lte(new Decimal('0.000000001'))) return true;
  await db.insert(reconcileDiscrepancies).values({
    scope: 'channel',
    userId: null,
    expected: expected.toString(),
    actual: actual.toString(),
    diff: diff.toString(),
    detail: `渠道在途敞口不平（channel=${channelId}）：channels.upstream_reserved ${actual.toString()} vs 活跃请求敞口和 ${expected.toString()}`,
  });
  return false;
}

/**
 * 渠道维度批量对账（R4 接线）：覆盖「近 N 天有账单」或「当前在途敞口非 0」的渠道。
 * 此前 reconcileChannelReserved 从未被调度，渠道敞口泄漏只能靠人工发现。
 */
export async function reconcileChannels(
  db: Db,
  recentDays = 7,
): Promise<{ checkedChannels: number; discrepancies: number }> {
  const candidates = await db.execute<{ channel_id: number }>(sql`
    select distinct channel_id from billing_requests
      where channel_id is not null
        and created_at >= now() - (${recentDays}::text || ' days')::interval
    union
    select id as channel_id from channels where upstream_reserved <> 0
  `);
  let discrepancies = 0;
  for (const row of candidates.rows) {
    const ok = await reconcileChannelReserved(db, Number(row.channel_id));
    if (!ok) discrepancies += 1;
  }
  return { checkedChannels: candidates.rows.length, discrepancies };
}
