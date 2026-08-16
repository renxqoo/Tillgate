import { sql, gte, lte, eq } from 'drizzle-orm';
import { usageLogs, users } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { buildList, countAll, listQuerySchema, paginateQuery } from '@ai-gateway/http';
import type { AdminServices } from './index.js';

/**
 * 用量明细服务（管理端专属，2026-08-17 估算结算政策配套）：
 * 每一笔扣款（含估算扣款）对管理员可见——estimated/estimateReason 一等字段，
 * 估算单在页面打「估算」标（用户端不透出，见政策留档）。
 */

export const usageLogsQuerySchema = listQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  userId: z.coerce.number().int().min(1).optional(),
  model: z.string().max(64).optional(),
  /** 只看估算扣款（2026-08-17 政策观测入口）。字符串显式解析——coerce.boolean 会把 'false' 变 true */
  estimated: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .optional(),
});

export async function listUsageLogs(s: AdminServices, q: z.infer<typeof usageLogsQuerySchema>) {
  const { page, limit, offset, where, orderBy } = buildList(q, {
    search: [
      usageLogs.externalModel,
      usageLogs.realModel,
      sql`${usageLogs.requestId}::text`,
    ],
    conditions: [
      eq(usageLogs.status, 0),
      q.from ? gte(usageLogs.createdAt, new Date(q.from)) : undefined,
      q.to ? lte(usageLogs.createdAt, new Date(q.to)) : undefined,
      q.userId !== undefined ? eq(usageLogs.userId, q.userId) : undefined,
      q.model ? eq(usageLogs.externalModel, q.model) : undefined,
      q.estimated !== undefined ? eq(usageLogs.estimated, q.estimated) : undefined,
    ],
    sort: {
      by: {
        id: usageLogs.id,
        amount: usageLogs.amount,
        inputTokens: usageLogs.inputTokens,
        outputTokens: usageLogs.outputTokens,
        durationMs: usageLogs.durationMs,
        createdAt: usageLogs.createdAt,
      },
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
        userName: users.displayName,
        credentialType: usageLogs.credentialType,
        externalModel: usageLogs.externalModel,
        realModel: usageLogs.realModel,
        inputTokens: usageLogs.inputTokens,
        cachedInputTokens: usageLogs.cachedInputTokens,
        outputTokens: usageLogs.outputTokens,
        amount: usageLogs.amount,
        calculatedAmount: usageLogs.calculatedAmount,
        planAmount: usageLogs.planAmount,
        paygAmount: usageLogs.paygAmount,
        billedBy: usageLogs.billedBy,
        upstreamCost: usageLogs.upstreamCost,
        durationMs: usageLogs.durationMs,
        stream: usageLogs.stream,
        streamAborted: usageLogs.streamAborted,
        /** 估算结算标记（2026-08-17 政策）：取消/完成缺 usage 的估算扣款 */
        estimated: usageLogs.estimated,
        estimateReason: usageLogs.estimateReason,
        createdAt: usageLogs.createdAt,
      })
      .from(usageLogs)
      .leftJoin(users, eq(usageLogs.userId, users.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    countAll(s.db, usageLogs, where),
  );
}
