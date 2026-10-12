/**
 * 用量查询面（usage_logs 是 billing 账本投影；跨 accounts/control-plane 名称富化的
 * app-face join）。
 * 明细 id 倒序 + 名称富化；按模型聚合默认 30 天窗、按消费额排序；
 * 按日汇总为 CLIENT_USAGE_TZ 日界；实时速率为 60s 窗 rpm/tpm。
 */
import { and, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { apiKeys, apps, modelMappings, usageLogs, type Db } from '@tillgate/db';
import type {
  UsageByModelRow,
  UsageDayRow,
  UsageTrendRow,
  UsageWireRow,
} from '../http/contracts/usage.js';

export interface UsageReadInput {
  page: number;
  limit: number;
  from?: Date;
  to?: Date;
  model?: string;
}

export interface UsageRead {
  list(userId: number, q: UsageReadInput): Promise<{ rows: UsageWireRow[]; total: number }>;
  byModel(userId: number, r: { from?: Date; to?: Date }): Promise<UsageByModelRow[]>;
  summary(userId: number, r: { from?: Date; to?: Date }): Promise<{ list: UsageDayRow[] }>;
  trend(
    userId: number,
    r: { granularity: 'day' | 'hour'; from?: Date },
  ): Promise<{ granularity: 'day' | 'hour'; list: UsageTrendRow[] }>;
  rate(userId: number): Promise<{ rpm: number; tpm: number }>;
}

/** by-model 默认 30 天窗（避免全表聚合） */
const BY_MODEL_WINDOW_MS = 30 * 24 * 3_600_000;

/** trend day 模式缺省回溯窗（近 14 天；from 未给时凭后端，与前端窗口同口径） */
const TREND_DAY_WINDOW_MS = 14 * 24 * 3_600_000;

/**
 * trend 桶键表达式：day = yyyy-MM-dd；hour = yyyy-MM-dd"T"HH:00:00。
 * 格式串以字面量入 SQL——to_char 第二参不接受参数占位（且 GROUP BY 与
 * SELECT 占位符不一致 PG 无法匹配；timezone 经 config 白名单校验，无注入面）。
 */
function trendBucketKey(granularity: 'day' | 'hour', timezone: string): SQL<string> {
  const tz = sql.raw(`'${timezone}'`);
  const dayKey = sql<string>`to_char(${usageLogs.createdAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;
  if (granularity === 'day') return dayKey;
  return sql<string>`${dayKey} || 'T' || to_char(${usageLogs.createdAt} AT TIME ZONE ${tz}, 'HH24:00:00')`;
}

/** 时间窗条件入参（options 形态,守住参数规模上限） */
interface UsageWindowQuery {
  userId: number;
  from?: Date;
  to?: Date;
  /** 缺省回溯窗(from 未给时兜底;by-model 30 天口径) */
  defaultFromMs?: number;
}

function windowConditions(query: UsageWindowQuery): SQL[] {
  const { userId, from, to, defaultFromMs } = query;
  const conditions: SQL[] = [eq(usageLogs.userId, userId)];
  const effectiveFrom =
    from ?? (defaultFromMs != null ? new Date(Date.now() - defaultFromMs) : undefined);
  if (effectiveFrom != null) conditions.push(gte(usageLogs.createdAt, effectiveFrom));
  if (to != null) conditions.push(lte(usageLogs.createdAt, to));
  return conditions;
}

// eslint-disable-next-line max-lines-per-function -- 读模型工厂:四个查询方法的 SQL 列投影平铺(列定义即数据)
export function createUsageRead(db: Db, timezone: string): UsageRead {
  return {
    // eslint-disable-next-line max-lines-per-function -- list 列投影 24 列平铺(join 三表),行数来自列定义
    async list(userId, q) {
      const conditions = windowConditions({ userId, from: q.from, to: q.to });
      if (q.model != null) conditions.push(eq(usageLogs.externalModel, q.model));
      const where = and(...conditions);
      const rows = await db
        .select({
          id: usageLogs.id,
          requestId: usageLogs.requestId,
          userId: usageLogs.userId,
          appId: usageLogs.appId,
          apiKeyId: usageLogs.apiKeyId,
          externalModel: usageLogs.externalModel,
          realModel: usageLogs.realModel,
          channelId: usageLogs.channelId,
          inputTokens: usageLogs.inputTokens,
          cachedInputTokens: usageLogs.cachedInputTokens,
          outputTokens: usageLogs.outputTokens,
          units: usageLogs.units,
          unitPrice: usageLogs.unitPrice,
          amount: usageLogs.amount,
          billedBy: usageLogs.billedBy,
          planAmount: usageLogs.planAmount,
          paygAmount: usageLogs.paygAmount,
          upstreamCost: usageLogs.upstreamCost,
          durationMs: usageLogs.durationMs,
          clientTtftMs: usageLogs.clientTtftMs,
          createdAt: usageLogs.createdAt,
          credentialType: usageLogs.credentialType,
          keyName: apiKeys.name,
          appName: apps.name,
          pricingUnit: modelMappings.pricingUnit,
        })
        .from(usageLogs)
        .leftJoin(apiKeys, eq(usageLogs.apiKeyId, apiKeys.id))
        .leftJoin(apps, eq(usageLogs.appId, apps.id))
        // 仅在册行：外部名对在册记录唯一（部分唯一索引），排除已删除行避免同名 join 用量翻倍
        .leftJoin(
          modelMappings,
          and(
            eq(usageLogs.externalModel, modelMappings.externalName),
            isNull(modelMappings.deletedAt),
          ),
        )
        .where(where)
        .orderBy(desc(usageLogs.id))
        .limit(q.limit)
        .offset((q.page - 1) * q.limit);
      const totals = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(usageLogs)
        .where(where);
      return {
        rows: rows.map((r) => ({ ...r, requestId: String(r.requestId) })) as UsageWireRow[],
        total: totals[0]?.count ?? 0,
      };
    },

    async byModel(userId, r) {
      const rows = await db
        .select({
          model: usageLogs.externalModel,
          requests: sql<string>`count(*)::bigint`,
          inputTokens: sql<string>`coalesce(sum(${usageLogs.inputTokens}), 0)::bigint`,
          outputTokens: sql<string>`coalesce(sum(${usageLogs.outputTokens}), 0)::bigint`,
          cachedInputTokens: sql<string>`coalesce(sum(${usageLogs.cachedInputTokens}), 0)::bigint`,
          cost: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::text`,
        })
        .from(usageLogs)
        .where(
          and(
            ...windowConditions({
              userId,
              from: r.from,
              to: r.to,
              defaultFromMs: BY_MODEL_WINDOW_MS,
            }),
          ),
        )
        .groupBy(usageLogs.externalModel)
        .orderBy(desc(sql`coalesce(sum(${usageLogs.amount}), 0)`));
      return rows.map((agg) => ({
        model: agg.model,
        requests: Number(agg.requests),
        inputTokens: Number(agg.inputTokens),
        outputTokens: Number(agg.outputTokens),
        cachedInputTokens: Number(agg.cachedInputTokens),
        cost: agg.cost,
      }));
    },

    async summary(userId, r) {
      // 时区经 config 字符白名单校验后以字面量入 SQL——参数化形态下 GROUP BY 表达式
      // 与 SELECT 表达式的占位符不一致（$1≠$2），PG 无法匹配（实测确认）
      const dayKey = sql<string>`to_char(${usageLogs.createdAt} AT TIME ZONE ${sql.raw(`'${timezone}'`)}, 'YYYY-MM-DD')`;
      const rows = await db
        .select({
          date: dayKey,
          requests: sql<string>`count(*)::bigint`,
          inputTokens: sql<string>`coalesce(sum(${usageLogs.inputTokens}), 0)::bigint`,
          outputTokens: sql<string>`coalesce(sum(${usageLogs.outputTokens}), 0)::bigint`,
          cachedInputTokens: sql<string>`coalesce(sum(${usageLogs.cachedInputTokens}), 0)::bigint`,
          cost: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::text`,
        })
        .from(usageLogs)
        .where(and(...windowConditions({ userId, from: r.from, to: r.to })))
        .groupBy(dayKey)
        .orderBy(sql`1`);
      return {
        list: rows.map((agg) => ({
          date: agg.date,
          requests: Number(agg.requests),
          inputTokens: Number(agg.inputTokens),
          outputTokens: Number(agg.outputTokens),
          cachedInputTokens: Number(agg.cachedInputTokens),
          cost: agg.cost,
        })),
      };
    },

    async rate(userId) {
      const rows = await db
        .select({
          rpm: sql<string>`count(*)::bigint`,
          tpm: sql<string>`coalesce(sum(${usageLogs.inputTokens} + ${usageLogs.outputTokens}), 0)::bigint`,
        })
        .from(usageLogs)
        .where(
          and(
            eq(usageLogs.userId, userId),
            gte(usageLogs.createdAt, sql`now() - interval '60 seconds'`),
          ),
        );
      return { rpm: Number(rows[0]?.rpm ?? 0), tpm: Number(rows[0]?.tpm ?? 0) };
    },

    // trend 聚合：桶键（day=日界分组/hour=当地时点取整小时）× 模型维度；
    // day 接受 from（缺省后端回溯 14 天）；hour 窗口固定为「今日当地 00:00 起」
    // （不接受 from——「今日」边界由后端单一真相推导，见方案 §契约）
    async trend(userId, r) {
      const tzLiteral = sql.raw(`'${timezone}'`);
      const isHour = r.granularity === 'hour';
      const bucketKey = trendBucketKey(r.granularity, timezone);
      const conditions: SQL[] = [eq(usageLogs.userId, userId)];
      if (isHour) {
        // 今日当地 00:00（两段式消偏同前端 zonedDayStart 口径；SQL 侧用 date_trunc 推导下界）
        conditions.push(
          gte(
            usageLogs.createdAt,
            sql`date_trunc('day', now() AT TIME ZONE ${tzLiteral}) AT TIME ZONE ${tzLiteral}`,
          ),
        );
      } else {
        const from = r.from ?? new Date(Date.now() - TREND_DAY_WINDOW_MS);
        conditions.push(gte(usageLogs.createdAt, from));
      }
      const rows = await db
        .select({
          bucket: bucketKey,
          model: usageLogs.externalModel,
          requests: sql<string>`count(*)::bigint`,
          inputTokens: sql<string>`coalesce(sum(${usageLogs.inputTokens}), 0)::bigint`,
          outputTokens: sql<string>`coalesce(sum(${usageLogs.outputTokens}), 0)::bigint`,
          cachedInputTokens: sql<string>`coalesce(sum(${usageLogs.cachedInputTokens}), 0)::bigint`,
          cost: sql<string>`coalesce(sum(${usageLogs.amount}), 0)::text`,
        })
        .from(usageLogs)
        .where(and(...conditions))
        .groupBy(bucketKey, usageLogs.externalModel)
        .orderBy(sql`1`, usageLogs.externalModel);
      return {
        granularity: r.granularity,
        list: rows.map((agg) => ({
          bucket: agg.bucket,
          model: agg.model,
          requests: Number(agg.requests),
          inputTokens: Number(agg.inputTokens),
          outputTokens: Number(agg.outputTokens),
          cachedInputTokens: Number(agg.cachedInputTokens),
          cost: agg.cost,
        })),
      };
    },
  };
}
