import { eq, and, sql, gte, lte } from 'drizzle-orm';
import { usageLogs, apiKeys, apps } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  paginateQuery, listQuerySchema, buildList, countAll } from '@ai-gateway/http';
import type { ClientServices } from './index.js';

/**
 * 用户面板：用量查询（api-contract §4.3）——明细/实时速率/按日/按模型聚合。
 */

export const usageQuerySchema = listQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  model: z.string().max(64).optional(),
});

export const rangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/** 实时速率（近 60 秒）：RPM = 请求数，TPM = 输入+输出 token */
export async function getUsageRate(s: ClientServices, userId: number) {
  const since = new Date(Date.now() - 60_000);
  const [row] = await s.db
    .select({
      requests: sql<number>`count(*)::int`,
      tokens: sql<string>`coalesce(sum(${usageLogs.inputTokens} + ${usageLogs.outputTokens}), 0)::text`,
    })
    .from(usageLogs)
    .where(and(eq(usageLogs.userId, userId), gte(usageLogs.createdAt, since)));
  return { rpm: Number(row?.requests ?? 0), tpm: Number(row?.tokens ?? 0) };
}

export async function listUsage(s: ClientServices, userId: number, q: z.infer<typeof usageQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(q, {
    search: [usageLogs.externalModel, usageLogs.realModel, sql`${usageLogs.requestId}::text`],
    conditions: [
      eq(usageLogs.userId, userId),
      q.from ? gte(usageLogs.createdAt, new Date(q.from)) : undefined,
      q.to ? lte(usageLogs.createdAt, new Date(q.to)) : undefined,
      q.model ? eq(usageLogs.externalModel, q.model) : undefined,
    ],
    sort: {
      by: { id: usageLogs.id, amount: usageLogs.amount, durationMs: usageLogs.durationMs, createdAt: usageLogs.createdAt },
      fallback: 'createdAt',
      tiebreaker: usageLogs.id,
    },
  });
  return paginateQuery(
    page,
    s.db
      .select({
        id: usageLogs.id,
        requestId: usageLogs.requestId,
        userId: usageLogs.userId,
        appId: usageLogs.appId,
        apiKeyId: usageLogs.apiKeyId,
        credentialType: usageLogs.credentialType,
        externalModel: usageLogs.externalModel,
        realModel: usageLogs.realModel,
        channelId: usageLogs.channelId,
        inputTokens: usageLogs.inputTokens,
        cachedInputTokens: usageLogs.cachedInputTokens,
        outputTokens: usageLogs.outputTokens,
        amount: usageLogs.amount,
        /** 计费来源拆分（套餐=积分 / 余额=金额，前端区分展示） */
        billedBy: usageLogs.billedBy,
        planAmount: usageLogs.planAmount,
        paygAmount: usageLogs.paygAmount,
        upstreamCost: usageLogs.upstreamCost,
        durationMs: usageLogs.durationMs,
        createdAt: usageLogs.createdAt,
        // 来源：key 名称（credentialType=key）/ app 名称（credentialType=jwt）
        keyName: apiKeys.name,
        appName: apps.name,
      })
      .from(usageLogs)
      .leftJoin(apiKeys, eq(usageLogs.apiKeyId, apiKeys.id))
      .leftJoin(apps, eq(usageLogs.appId, apps.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, usageLogs, where),
  );
}

/** 按日聚合（图表用） */
export async function usageSummary(s: ClientServices, userId: number, q: z.infer<typeof rangeQuerySchema>) {
  const conds = [eq(usageLogs.userId, userId)];
  if (q.from) conds.push(gte(usageLogs.createdAt, new Date(q.from)));
  if (q.to) conds.push(lte(usageLogs.createdAt, new Date(q.to)));
  const where = and(...conds);
  const day = sql`to_char(${usageLogs.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await s.db
    .select({
      date: sql<string>`${day}`,
      requests: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}),0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${usageLogs.outputTokens}),0)::bigint`,
      cachedInputTokens: sql<number>`coalesce(sum(${usageLogs.cachedInputTokens}),0)::bigint`,
      cost: sql<string>`coalesce(sum(${usageLogs.amount}),0)::numeric`,
    })
    .from(usageLogs)
    .where(where)
    .groupBy(day)
    .orderBy(day);
  return { list: rows };
}

/** 按模型聚合（图表用：不同模型的使用量分布；默认近 30 天） */
export async function usageByModel(s: ClientServices, userId: number, q: z.infer<typeof rangeQuerySchema>) {
  const conds = [eq(usageLogs.userId, userId)];
  // 默认近 30 天（避免全量；from 未传时回退 30 天前）
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400_000);
  conds.push(gte(usageLogs.createdAt, from));
  if (q.to) conds.push(lte(usageLogs.createdAt, new Date(q.to)));
  const where = and(...conds);
  const rows = await s.db
    .select({
      model: usageLogs.externalModel,
      requests: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}),0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${usageLogs.outputTokens}),0)::bigint`,
      cachedInputTokens: sql<number>`coalesce(sum(${usageLogs.cachedInputTokens}),0)::bigint`,
      cost: sql<string>`coalesce(sum(${usageLogs.amount}),0)::numeric`,
    })
    .from(usageLogs)
    .where(where)
    .groupBy(usageLogs.externalModel)
    .orderBy(sql`coalesce(sum(${usageLogs.amount}),0) desc`);
  return {
    list: rows.map((r) => ({
      model: r.model,
      requests: Number(r.requests),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cachedInputTokens: Number(r.cachedInputTokens),
      // 金额全程字符串（与 /summary 一致；Number() 会 IEEE754 化聚合金额）
      cost: r.cost,
    })),
  };
}
