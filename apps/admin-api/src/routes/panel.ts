import { Hono } from 'hono';
import { eq, and, sql, gte, lte, desc } from 'drizzle-orm';
import { users, rateCards, transactions, usageLogs } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { jsonBody, query } from '../lib/validation.js';
import { z } from 'zod';
import {
  paginationQuerySchema,
  parsePagination,
  limitOffset,
  paginatedResult,
} from '../lib/pagination.js';
import { redeemCode } from '../lib/redeem.js';
import { getAdminRedis } from '../lib/route-invalidation.js';
import type { AdminEnv } from '../middleware/session.js';

/**
 * 用户面板（api-contract §4.1 / §4.3）。
 *
 *   - GET /api/me：当前用户信息（余额、订阅摘要、状态）
 *   - GET /api/me/transactions：自己的资金流水
 *   - POST /api/redeem：兑换充值码
 *   - GET /api/usage：自己的用量明细
 *   - GET /api/usage/summary：按日聚合
 */

const redeemSchema = z.object({ code: z.string().min(1).max(64) });

const usageQuerySchema = paginationQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  model: z.string().optional(),
});

const txQuerySchema = paginationQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export function panelRoutes(db: Db): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 当前用户信息
    .get('/api/me', async (c) => {
      const session = c.get('session');
      const rows = await db
        .select({
          id: users.id,
          subject: users.subject,
          email: users.email,
          displayName: users.displayName,
          role: users.role,
          rateCardId: users.rateCardId,
          rateCardName: rateCards.name,
          balance: users.balance,
          status: users.status,
          rpmLimit: users.rpmLimit,
          tpmLimit: users.tpmLimit,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
        })
        .from(users)
        .leftJoin(rateCards, eq(users.rateCardId, rateCards.id))
        .where(eq(users.id, session.userId))
        .limit(1);
      if (rows.length === 0) return c.json({ error: '用户不存在' }, 404);
      return c.json(rows[0]);
    })

    // 资金流水
    .get('/api/me/transactions', query(txQuerySchema), async (c) => {
      const session = c.get('session');
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const conds = [eq(transactions.userId, session.userId)];
      if (q.from) conds.push(gte(transactions.createdAt, new Date(q.from)));
      if (q.to) conds.push(lte(transactions.createdAt, new Date(q.to)));
      const where = and(...conds);
      const [rows, countRows] = await Promise.all([
        db.select().from(transactions).where(where).orderBy(desc(transactions.createdAt)).limit(limit).offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(transactions).where(where),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 兑换充值码
    .post('/api/redeem', jsonBody(redeemSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');
      // P-1 修复：兑换限流（防脚本爆破充值码，10 次/分钟）
      const redis = getAdminRedis();
      if (redis) {
        const key = `redeem:rl:${session.userId}`;
        const n = await redis.incr(key);
        if (n === 1) await redis.expire(key, 60);
        if (n > 10) {
          const ttl = await redis.ttl(key);
          c.header('retry-after', String(Math.max(1, ttl)));
          return c.json({ error: { message: '兑换过于频繁，请稍后再试', code: 'RATE_LIMITED' } }, 429);
        }
      }
      const r = await redeemCode(db, session.userId, body.code, getAdminRedis());
      if (!r.ok) {
        const code = r.code ?? 'invalid_code';
        // 错误码 → HTTP 状态（api-contract §4.1）
        const status: 400 | 409 = code === 'code_already_used' ? 409 : 400;
        return c.json({ error: { message: code, code } }, status);
      }
      return c.json({ ok: true, amount: r.amount, balanceAfter: r.balanceAfter });
    })

    // 用量明细
    .get('/api/usage', query(usageQuerySchema), async (c) => {
      const session = c.get('session');
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const conds = [eq(usageLogs.userId, session.userId)];
      if (q.from) conds.push(gte(usageLogs.createdAt, new Date(q.from)));
      if (q.to) conds.push(lte(usageLogs.createdAt, new Date(q.to)));
      if (q.model) conds.push(eq(usageLogs.externalModel, q.model));
      const where = and(...conds);
      const [rows, countRows] = await Promise.all([
        db.select().from(usageLogs).where(where).orderBy(desc(usageLogs.createdAt)).limit(limit).offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(usageLogs).where(where),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 用量按日聚合（图表用）
    .get('/api/usage/summary', query(z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    })), async (c) => {
      const session = c.get('session');
      const q = c.req.valid('query');
      const conds = [eq(usageLogs.userId, session.userId)];
      if (q.from) conds.push(gte(usageLogs.createdAt, new Date(q.from)));
      if (q.to) conds.push(lte(usageLogs.createdAt, new Date(q.to)));
      const where = and(...conds);
      // 按日聚合：requests / input_tokens / output_tokens / cost
      const rows = await db
        .select({
          date: sql<string>`to_char(${usageLogs.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
          requests: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${usageLogs.inputTokens}),0)::bigint`,
          outputTokens: sql<number>`coalesce(sum(${usageLogs.outputTokens}),0)::bigint`,
          cachedInputTokens: sql<number>`coalesce(sum(${usageLogs.cachedInputTokens}),0)::bigint`,
          cost: sql<string>`coalesce(sum(${usageLogs.amount}),0)::numeric`,
        })
        .from(usageLogs)
        .where(where)
        .groupBy(sql`to_char(${usageLogs.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${usageLogs.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`);
      return c.json({ list: rows });
    });
}
