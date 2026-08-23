import { and, asc, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import type { Db } from '@tokenlens/db';
import { channels, modelMappings, usageLogs, users } from '@tokenlens/db';
import type {
  ChannelTtftRow,
  UsageAdminListInput,
  UsageAdminRow,
  UsageGroupStoreRow,
  UsageStatsStore,
  UsageTotalsRow,
  UsageTrendStoreRow,
} from '../../usage/types';
import { escapeLikePattern } from './search';

/**
 * usage_logs 运维查询的 PG 适配(v1 usage-log.repo 管理面族逐语义平移):
 * 管理列表 / 概览三段 / 分组聚合 / 按日趋势 / 渠道首字延迟。
 * 聚合口径与 v1 逐条对照——排序稳定序、bigint 回传字符串映射、
 * 趋势日界 at time zone 'Asia/Shanghai' 与 day-window 纯函数同口径。
 */
export function createPgUsageStore(db: Db): UsageStatsStore {
  return {
    /** 管理列表:q 命中 外部名/真实名/requestId(uuid 转文本);恒 status=0 已计费 */
    async adminList(input: UsageAdminListInput) {
      const conditions = [eq(usageLogs.status, 0)];
      if (input.q) {
        const pattern = escapeLikePattern(input.q);
        conditions.push(
          or(
            ilike(usageLogs.externalModel, pattern),
            ilike(usageLogs.realModel, pattern),
            sql`${usageLogs.requestId}::text ilike ${pattern}`,
          )!,
        );
      }
      if (input.from) conditions.push(gte(usageLogs.createdAt, input.from));
      if (input.to) conditions.push(lte(usageLogs.createdAt, input.to));
      if (input.userId !== undefined) conditions.push(eq(usageLogs.userId, input.userId));
      if (input.model) conditions.push(eq(usageLogs.externalModel, input.model));
      if (input.estimated !== undefined) conditions.push(eq(usageLogs.estimated, input.estimated));
      const where = and(...conditions);
      const sorts = {
        id: usageLogs.id,
        amount: usageLogs.amount,
        inputTokens: usageLogs.inputTokens,
        outputTokens: usageLogs.outputTokens,
        durationMs: usageLogs.durationMs,
        createdAt: usageLogs.createdAt,
      } as const;
      const column = sorts[input.sortBy];
      const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(usageLogs.id)];
      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: usageLogs.id,
            requestId: usageLogs.requestId,
            userId: usageLogs.userId,
            userName: users.displayName,
            credentialType: usageLogs.credentialType,
            externalModel: usageLogs.externalModel,
            realModel: usageLogs.realModel,
            inputTokens: usageLogs.inputTokens,
            cachedInputTokens: usageLogs.cachedInputTokens,
            outputTokens: usageLogs.outputTokens,
            units: usageLogs.units,
            unitPrice: usageLogs.unitPrice,
            pricingUnit: modelMappings.pricingUnit,
            amount: usageLogs.amount,
            calculatedAmount: usageLogs.calculatedAmount,
            planAmount: usageLogs.planAmount,
            paygAmount: usageLogs.paygAmount,
            billedBy: usageLogs.billedBy,
            upstreamCost: usageLogs.upstreamCost,
            durationMs: usageLogs.durationMs,
            upstreamTtftMs: usageLogs.upstreamTtftMs,
            clientTtftMs: usageLogs.clientTtftMs,
            stream: usageLogs.stream,
            streamAborted: usageLogs.streamAborted,
            estimated: usageLogs.estimated,
            estimateReason: usageLogs.estimateReason,
            createdAt: usageLogs.createdAt,
          })
          .from(usageLogs)
          .leftJoin(users, eq(usageLogs.userId, users.id))
          .leftJoin(modelMappings, eq(usageLogs.externalModel, modelMappings.externalName))
          .where(where)
          .orderBy(...orderBy)
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(usageLogs)
          .where(where),
      ]);
      return { rows: rows as UsageAdminRow[], total: countRows[0]?.count ?? 0 };
    },

    /** 概览·今日:全量行(不筛 status;successCount 才筛 status=0) */
    async overviewToday(since: Date) {
      const [row] = await db
        .select({
          requests: sql<number>`count(*)::int`,
          inputTokens: sql<string>`coalesce(sum(${usageLogs.inputTokens}), 0)::bigint::text`,
          outputTokens: sql<string>`coalesce(sum(${usageLogs.outputTokens}), 0)::bigint::text`,
          cost: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::numeric::text`,
          successCount: sql<number>`count(*) filter (where ${usageLogs.status} = 0)::int`,
        })
        .from(usageLogs)
        .where(gte(usageLogs.createdAt, since));
      return (
        row ?? { requests: 0, inputTokens: '0', outputTokens: '0', cost: '0', successCount: 0 }
      );
    },

    /** 概览·累计:总消费与总请求数 */
    async overviewTotals() {
      const [row] = await db
        .select({
          cost: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::numeric::text`,
          requests: sql<number>`count(*)::int`,
        })
        .from(usageLogs);
      return (row as UsageTotalsRow | undefined) ?? { cost: '0', requests: 0 };
    },

    /** 概览·渠道健康:按状态分组的渠道数 */
    async channelStatusCounts() {
      return db
        .select({ status: channels.status, count: sql<number>`count(*)::int` })
        .from(channels)
        .groupBy(channels.status)
        .orderBy(asc(channels.status));
    },

    /** 用量分组聚合(user/model/channel 三轴;按消费降序 limit 200) */
    async usageGroups(input: { group: 'user' | 'model' | 'channel'; from?: Date; to?: Date }) {
      const conditions = [];
      if (input.from) conditions.push(gte(usageLogs.createdAt, input.from));
      if (input.to) conditions.push(lte(usageLogs.createdAt, input.to));
      const where = conditions.length ? and(...conditions) : undefined;
      const groupCol =
        input.group === 'user'
          ? usageLogs.userId
          : input.group === 'channel'
            ? usageLogs.channelId
            : usageLogs.externalModel;
      const rows = await db
        .select({
          key: groupCol,
          requests: sql<number>`count(*)::int`,
          inputTokens: sql<string>`coalesce(sum(${usageLogs.inputTokens}), 0)::bigint::text`,
          outputTokens: sql<string>`coalesce(sum(${usageLogs.outputTokens}), 0)::bigint::text`,
          cachedInputTokens: sql<string>`coalesce(sum(${usageLogs.cachedInputTokens}), 0)::bigint::text`,
          cost: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::numeric::text`,
          upstreamCost: sql<string>`coalesce(sum(${usageLogs.upstreamCost}), 0)::numeric::text`,
        })
        .from(usageLogs)
        .where(where)
        .groupBy(groupCol)
        .orderBy(desc(sql`sum(${usageLogs.amount})`))
        .limit(200);
      return rows as UsageGroupStoreRow[];
    },

    /**
     * 按日趋势(管理台折线图数据源):日界北京时间——UTC 日界会把早 8 点前的量
     * 切进昨日。只带 from 下界(今日子集随时间自然增长,无上界竞态)。
     */
    async dailyTrends(from: Date) {
      const day = sql`to_char(${usageLogs.createdAt} at time zone 'Asia/Shanghai', 'YYYY-MM-DD')`;
      const rows = await db
        .select({
          date: sql<string>`${day}`,
          requests: sql<number>`count(*)::int`,
          successCount: sql<number>`count(*) filter (where ${usageLogs.status} = 0)::int`,
          inputTokens: sql<string>`coalesce(sum(${usageLogs.inputTokens}), 0)::bigint::text`,
          outputTokens: sql<string>`coalesce(sum(${usageLogs.outputTokens}), 0)::bigint::text`,
          cost: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::numeric::text`,
        })
        .from(usageLogs)
        .where(gte(usageLogs.createdAt, from))
        .groupBy(day)
        .orderBy(day);
      return rows as UsageTrendStoreRow[];
    },

    /**
     * 渠道首字延迟聚合(双向 P50/P95):只统计流式成功样本(ttft 列流式专属);
     * percentile_cont 库端聚合。pg int8/numeric 回传字符串——显式 Number 映射
     * (延迟取整是展示统计,非资金运算)。
     */
    async channelTtft(since: Date) {
      const result = await db.execute<{
        channel_id: number | null;
        channel_name: string | null;
        samples: number;
        upstream_p50: string | null;
        upstream_p95: string | null;
        client_p50: string | null;
        client_p95: string | null;
      }>(sql`
        select u.channel_id,
               ch.name as channel_name,
               count(*)::int as samples,
               percentile_cont(0.5) within group (order by u.upstream_ttft_ms) as upstream_p50,
               percentile_cont(0.95) within group (order by u.upstream_ttft_ms) as upstream_p95,
               percentile_cont(0.5) within group (order by u.client_ttft_ms) as client_p50,
               percentile_cont(0.95) within group (order by u.client_ttft_ms) as client_p95
        from usage_logs u
        left join channels ch on ch.id = u.channel_id
        where u.status = 0 and u.stream = true and u.client_ttft_ms is not null
          and u.created_at >= ${since}
        group by u.channel_id, ch.name
        order by samples desc
        limit 100
      `);
      return result.rows.map(
        (r): ChannelTtftRow => ({
          channelId: r.channel_id == null ? null : Number(r.channel_id),
          channelName: r.channel_name,
          samples: r.samples,
          upstreamP50: r.upstream_p50 == null ? null : Math.round(Number(r.upstream_p50)),
          upstreamP95: r.upstream_p95 == null ? null : Math.round(Number(r.upstream_p95)),
          clientP50: r.client_p50 == null ? null : Math.round(Number(r.client_p50)),
          clientP95: r.client_p95 == null ? null : Math.round(Number(r.client_p95)),
        }),
      );
    },
  };
}
