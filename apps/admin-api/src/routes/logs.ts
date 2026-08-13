import { Hono } from 'hono';
import { sql, gte, lte, and, eq } from 'drizzle-orm';
import { requestLogs, auditLogs, users } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { limitOffset, paginateQuery, paginationQuerySchema, parsePagination, query } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';

/**
 * 日志查询（api-contract §4.8）。
 *
 *   - GET /api/admin/logs：请求日志（默认 30 天滚动，附 userName）
 *   - GET /api/admin/audit-logs：管理操作审计
 */

const logsQuerySchema = paginationQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  userId: z.coerce.number().int().optional(),
  statusCode: z.coerce.number().int().optional(),
  model: z.string().optional(),
});

/** 请求日志（挂载于 /api/admin/logs） */
export function logAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>().get('/', query(logsQuerySchema), async (c) => {
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

    const result = await paginateQuery(
      p,
      s.db
        .select({
          id: requestLogs.id,
          requestId: requestLogs.requestId,
          userId: requestLogs.userId,
          apiKeyId: requestLogs.apiKeyId,
          method: requestLogs.method,
          path: requestLogs.path,
          statusCode: requestLogs.statusCode,
          errorCode: requestLogs.errorCode,
          durationMs: requestLogs.durationMs,
          requestSummary: requestLogs.requestSummary,
          attempts: requestLogs.attempts,
          candidatesTried: requestLogs.candidatesTried,
          createdAt: requestLogs.createdAt,
          // 用户名（供前端展示）：优先 displayName，其次 email
          userName: sql<string | null>`coalesce(${users.displayName}, ${users.email})`.as('user_name'),
        })
        .from(requestLogs)
        .leftJoin(users, eq(requestLogs.userId, users.id))
        .where(where)
        .orderBy(sql`${requestLogs.createdAt} desc`)
        .limit(limit)
        .offset(offset),
      s.db.select({ count: sql<number>`count(*)::int` }).from(requestLogs).where(where),
    );
    return c.json(result);
  });
}

/** 管理操作审计（挂载于 /api/admin/audit-logs） */
export function auditLogAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>().get('/', query(paginationQuerySchema), async (c) => {
    const p = parsePagination(c.req.valid('query'));
    const { limit, offset } = limitOffset(p);
    const result = await paginateQuery(
      p,
      s.db.select().from(auditLogs).orderBy(sql`created_at desc`).limit(limit).offset(offset),
      s.db.select({ count: sql<number>`count(*)::int` }).from(auditLogs),
    );
    return c.json(result);
  });
}
