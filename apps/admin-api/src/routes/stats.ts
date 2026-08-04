import { Hono } from 'hono';
import { sql, gte, lte, and, eq } from 'drizzle-orm';
import { usageLogs, requestLogs, channels, auditLogs } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { query } from '../lib/validation.js';
import { z } from 'zod';
import {
  paginationQuerySchema,
  parsePagination,
  limitOffset,
  paginatedResult,
} from '../lib/pagination.js';
import type { AdminEnv } from '../middleware/session.js';

/**
 * 报表与仪表盘（api-contract §4.8）。
 *
 *   - GET /api/admin/stats/overview：仪表盘（今日请求量/tokens/费用/成功率/渠道健康）
 *   - GET /api/admin/stats/usage：多维度用量与费用聚合（group=user|model|channel）
 *   - GET /api/admin/logs：请求日志查询（30 天）
 *   - GET /api/admin/audit-logs：管理操作审计
 *
 * 注意：展示时区 Asia/Shanghai（requirements 4.10）——存储仍 UTC，查询时按需 to_char 转换。
 *       一期直接查 usage_logs（数据量不大）；P1 加 daily_stats 聚合表加速。
 */

const usageStatsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** 聚合维度 */
  group: z.enum(['user', 'model', 'channel']).default('model'),
});

const logsQuerySchema = paginationQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  userId: z.coerce.number().int().optional(),
  statusCode: z.coerce.number().int().optional(),
  model: z.string().optional(),
});

/** 今日 UTC 0 点（用于 overview） */
function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function statsAdminRoutes(db: Db): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 仪表盘概览
    .get('/api/admin/stats/overview', async (c) => {
      const today = startOfTodayUtc();
      // 今日 usage_logs 聚合
      const todayStats = await db
        .select({
          requests: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}),0)::bigint`,
          outputTokens: sql<number>`coalesce(sum(${usageLogs.outputTokens}),0)::bigint`,
          cost: sql<number>`coalesce(sum(${usageLogs.amount}),0)::bigint`,
          successCount: sql<number>`count(*) filter (where ${usageLogs.status} = 0)::int`,
        })
        .from(usageLogs)
        .where(gte(usageLogs.createdAt, today));
      const row = todayStats[0]!;
      const requests = Number(row?.requests ?? 0);
      const successCount = Number(row?.successCount ?? 0);
      const successRate = requests > 0 ? successCount / requests : 0;

      // 渠道健康状态分布
      const channelHealth = await db
        .select({
          status: channels.status,
          count: sql<number>`count(*)::int`,
        })
        .from(channels)
        .groupBy(channels.status);

      // 总用户数 / 总费用
      const totals = await db
        .select({
          totalCost: sql<number>`coalesce(sum(${usageLogs.amount}),0)::bigint`,
          totalRequests: sql<number>`count(*)::int`,
        })
        .from(usageLogs);

      return c.json({
        today: {
          requests,
          inputTokens: Number(row?.inputTokens ?? 0),
          outputTokens: Number(row?.outputTokens ?? 0),
          cost: Number(row?.cost ?? 0),
          successCount,
          failedCount: requests - successCount,
          successRate: Math.round(successRate * 1000) / 10, // 百分比保留 1 位
        },
        total: {
          cost: Number(totals[0]?.totalCost ?? 0),
          requests: Number(totals[0]?.totalRequests ?? 0),
        },
        channelHealth: channelHealth.map((h) => ({ status: h.status, count: Number(h.count) })),
      });
    })

    // 多维度用量与费用聚合
    .get('/api/admin/stats/usage', query(usageStatsQuerySchema), async (c) => {
      const q = c.req.valid('query');
      const conds = [];
      if (q.from) conds.push(gte(usageLogs.createdAt, new Date(q.from)));
      if (q.to) conds.push(lte(usageLogs.createdAt, new Date(q.to)));
      const where = conds.length ? and(...conds) : undefined;

      // group 维度 → 对应列
      const groupCol = q.group === 'user'
        ? usageLogs.userId
        : q.group === 'channel'
          ? usageLogs.channelId
          : usageLogs.externalModel;

      const rows = await db
        .select({
          key: groupCol,
          requests: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}),0)::bigint`,
          outputTokens: sql<number>`coalesce(sum(${usageLogs.outputTokens}),0)::bigint`,
          cachedInputTokens: sql<number>`coalesce(sum(${usageLogs.cachedInputTokens}),0)::bigint`,
          cost: sql<number>`coalesce(sum(${usageLogs.amount}),0)::bigint`,
          upstreamCost: sql<number>`coalesce(sum(${usageLogs.upstreamCost}),0)::bigint`,
        })
        .from(usageLogs)
        .where(where)
        .groupBy(groupCol)
        .orderBy(sql`coalesce(sum(${usageLogs.amount}),0) desc`);
      return c.json({
        list: rows.map((r) => ({
          key: r.key,
          requests: Number(r.requests),
          inputTokens: Number(r.inputTokens),
          outputTokens: Number(r.outputTokens),
          cachedInputTokens: Number(r.cachedInputTokens),
          cost: Number(r.cost),
          upstreamCost: Number(r.upstreamCost),
        })),
      });
    })

    // 请求日志查询（30 天滚动）
    .get('/api/admin/logs', query(logsQuerySchema), async (c) => {
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const conds = [];
      // 默认查最近 30 天
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000);
      conds.push(gte(requestLogs.createdAt, q.from ? new Date(q.from) : thirtyDaysAgo));
      if (q.to) conds.push(lte(requestLogs.createdAt, new Date(q.to)));
      if (q.userId !== undefined) conds.push(eq(requestLogs.userId, q.userId));
      if (q.statusCode !== undefined) conds.push(eq(requestLogs.statusCode, q.statusCode));
      const where = and(...conds);
      const [rows, countRows] = await Promise.all([
        db
          .select()
          .from(requestLogs)
          .where(where)
          .orderBy(sql`${requestLogs.createdAt} desc`)
          .limit(limit)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(requestLogs).where(where),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 管理操作审计
    .get('/api/admin/audit-logs', query(paginationQuerySchema), async (c) => {
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const [rows, countRows] = await Promise.all([
        db.select().from(auditLogs).orderBy(sql`created_at desc`).limit(limit).offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(auditLogs),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    });
}
