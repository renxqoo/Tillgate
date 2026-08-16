import { sql, gte, lte, lt, and, eq, type SQL } from 'drizzle-orm';
import { requestLogs, auditLogs, users } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { buildList, countAll, listQuerySchema, paginateQuery } from '@ai-gateway/http';
import type { AdminServices } from './index.js';

/**
 * 日志查询服务（api-contract §4.8）：请求日志（默认 30 天滚动）与管理操作审计。
 */

export const logsQuerySchema = listQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  userId: z.coerce.number().int().min(1).optional(),
  /** 精确状态码，或分组 2xx/4xx/5xx（区间在 DB 层展开——前端当页过滤跨页失真，R10 下沉） */
  statusCode: z
    .union([z.coerce.number().int().min(100).max(599), z.enum(['2xx', '4xx', '5xx'])])
    .optional(),
});

function statusCodeCondition(v: number | '2xx' | '4xx' | '5xx'): SQL {
  if (v === '2xx') return and(gte(requestLogs.statusCode, 200), lt(requestLogs.statusCode, 300))!;
  if (v === '4xx') return and(gte(requestLogs.statusCode, 400), lt(requestLogs.statusCode, 500))!;
  if (v === '5xx') return and(gte(requestLogs.statusCode, 500), lt(requestLogs.statusCode, 600))!;
  return eq(requestLogs.statusCode, v);
}

export async function listRequestLogs(s: AdminServices, q: z.infer<typeof logsQuerySchema>) {
  // 默认查最近 30 天
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000);
  // requestId 是 uuid 列：ilike 需 ::text；计费复核单下钻全靠它
  const { page, limit, offset, where, orderBy } = buildList(q, {
    search: [
      requestLogs.path,
      requestLogs.errorCode,
      requestLogs.sourceIp,
      sql`${requestLogs.requestId}::text`,
    ],
    conditions: [
      gte(requestLogs.createdAt, q.from ? new Date(q.from) : thirtyDaysAgo),
      q.to ? lte(requestLogs.createdAt, new Date(q.to)) : undefined,
      q.userId !== undefined ? eq(requestLogs.userId, q.userId) : undefined,
      q.statusCode !== undefined ? statusCodeCondition(q.statusCode) : undefined,
    ],
    sort: {
      by: { id: requestLogs.id, statusCode: requestLogs.statusCode, durationMs: requestLogs.durationMs, createdAt: requestLogs.createdAt },
      fallback: 'createdAt',
      tiebreaker: requestLogs.id,
    },
  });

  return paginateQuery(
    page,
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
        sourceIp: requestLogs.sourceIp,
        createdAt: requestLogs.createdAt,
        // 用户名（供前端展示）：优先 displayName，其次 email
        userName: sql<string | null>`coalesce(${users.displayName}, ${users.email})`.as('user_name'),
      })
      .from(requestLogs)
      .leftJoin(users, eq(requestLogs.userId, users.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, requestLogs, where),
  );
}

export async function listAuditLogs(s: AdminServices, input: z.infer<typeof listQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(input, {
    search: [auditLogs.action, auditLogs.targetType, auditLogs.targetId],
    sort: {
      by: { id: auditLogs.id, action: auditLogs.action, createdAt: auditLogs.createdAt },
      fallback: 'createdAt',
      tiebreaker: auditLogs.id,
    },
  });
  return paginateQuery(
    page,
    s.db.select().from(auditLogs).where(where).orderBy(...orderBy).limit(limit).offset(offset),
    countAll(s.db, auditLogs, where),
  );
}
