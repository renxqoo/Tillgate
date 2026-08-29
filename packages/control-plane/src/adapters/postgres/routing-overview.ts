/**
 * 渠道路由观测聚合（管理台「智能路由」观测卡数据源）。
 * 双口径单一查询：失败/成功率 = billing_requests 生命周期面（每请求一行，
 * 失败行带 channel_id + failure_code——usage_logs 不记失败请求，用它算失败率恒 0）；
 * 用量/延迟/缓存命中 = usage_logs 结算面（资金事实表职责纯化）。
 * 不变量：两张事实表与 channels 均是一对多——必须各自先按 channel 预聚合成
 * 子查询再 join；同层双一对多 join 会产生 R×U 叉积，count/sum 被成倍放大。
 */
import { desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { billingRequests, channels, usageLogs } from '@tillgate/db';
import type { DbLike } from '@tillgate/db';

export interface RoutingOverviewRow {
  channelId: number;
  channelName: string;
  status: number;
  priority: number | null;
  upstreamBudget: string;
  upstreamRemaining: string;
  /** 近窗请求数（billing_requests 口径——含失败请求） */
  requests: number;
  /** 近窗失败数（released 且 failure_code 非空——网关侧拒绝/上游失败；管理员放弃等无码释放不计） */
  failures: number;
  avgDurationMs: number | null;
  avgClientTtftMs: number | null;
  cachedInputTokens: number;
  inputTokens: number;
}

/** 生命周期面预聚合：窗口内按渠道计数（失败 = released 且 failure_code 非空） */
function lifecycleAggOf(db: DbLike, since: Date) {
  return db
    .select({
      channelId: billingRequests.channelId,
      requests: sql<number>`count(*)::int`,
      failures: sql<number>`count(*) filter (where ${billingRequests.status} = 'released' and ${billingRequests.failureCode} is not null)::int`,
    })
    .from(billingRequests)
    .where(gte(billingRequests.createdAt, since))
    .groupBy(billingRequests.channelId)
    .as('lifecycle');
}

/** 结算面预聚合：窗口内按渠道的延迟与 token 汇总 */
function usageAggOf(db: DbLike, since: Date) {
  return db
    .select({
      channelId: usageLogs.channelId,
      avgDurationMs: sql<number | null>`avg(${usageLogs.durationMs})::bigint`,
      avgClientTtftMs: sql<number | null>`avg(${usageLogs.clientTtftMs})::bigint`,
      cachedInputTokens: sql<number>`coalesce(sum(${usageLogs.cachedInputTokens}), 0)::bigint`,
      inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}), 0)::bigint`,
    })
    .from(usageLogs)
    .where(gte(usageLogs.createdAt, since))
    .groupBy(usageLogs.channelId)
    .as('usage');
}

export async function routingChannelsOverview(
  db: DbLike,
  windowMs: number,
): Promise<RoutingOverviewRow[]> {
  const since = new Date(Date.now() - windowMs);
  const lifecycleAgg = lifecycleAggOf(db, since);
  const usageAgg = usageAggOf(db, since);
  const rows = await db
    .select({
      channelId: channels.id,
      channelName: channels.name,
      status: channels.status,
      priority: channels.priority,
      upstreamBudget: sql<string>`${channels.upstreamBudget}::text`,
      upstreamRemaining: sql<string>`(${channels.upstreamBudget} - ${channels.upstreamReserved})::text`,
      requests: sql<number>`coalesce(${lifecycleAgg.requests}, 0)::int`,
      failures: sql<number>`coalesce(${lifecycleAgg.failures}, 0)::int`,
      avgDurationMs: sql<number | null>`${usageAgg.avgDurationMs}`,
      avgClientTtftMs: sql<number | null>`${usageAgg.avgClientTtftMs}`,
      cachedInputTokens: sql<number>`coalesce(${usageAgg.cachedInputTokens}, 0)::bigint`,
      inputTokens: sql<number>`coalesce(${usageAgg.inputTokens}, 0)::bigint`,
    })
    .from(channels)
    .leftJoin(lifecycleAgg, eq(lifecycleAgg.channelId, channels.id))
    .leftJoin(usageAgg, eq(usageAgg.channelId, channels.id))
    .where(isNull(channels.deletedAt))
    .groupBy(channels.id)
    .orderBy(desc(channels.id));
  return rows.map((r) => ({
    ...r,
    avgDurationMs: r.avgDurationMs == null ? null : Number(r.avgDurationMs),
    avgClientTtftMs: r.avgClientTtftMs == null ? null : Number(r.avgClientTtftMs),
    cachedInputTokens: Number(r.cachedInputTokens),
    inputTokens: Number(r.inputTokens),
    requests: Number(r.requests),
    failures: Number(r.failures),
  }));
}
