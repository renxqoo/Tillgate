import { Hono } from 'hono';
import { eq, and, sql, gte, lte, desc } from 'drizzle-orm';
import { users, rateCards, transactions, usageLogs, redeemCodes, redeemBatches, apiKeys, apps } from '@ai-gateway/db/schema';
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
import { getSharedRedis } from '@ai-gateway/billing';
import type { ClientEnv } from '@ai-gateway/identity';

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

export function panelRoutes(db: Db): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 当前用户信息（拆分后不再返回 role：用户面 role 对用户无意义，且 role 列即将从 users 删除）
    .get('/api/me', async (c) => {
      const session = c.get('session');
      const rows = await db
        .select({
          id: users.id,
          subject: users.subject,
          email: users.email,
          displayName: users.displayName,
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

    // 实时速率（近 60 秒）：RPM = 请求数，TPM = 输入+输出 token
    .get('/api/usage/rate', async (c) => {
      const session = c.get('session');
      const since = new Date(Date.now() - 60_000);
      const [row] = await db
        .select({
          requests: sql<number>`count(*)::int`,
          tokens: sql<string>`coalesce(sum(${usageLogs.inputTokens} + ${usageLogs.outputTokens}), 0)::text`,
        })
        .from(usageLogs)
        .where(and(eq(usageLogs.userId, session.userId), gte(usageLogs.createdAt, since)));
      return c.json({ rpm: Number(row?.requests ?? 0), tpm: Number(row?.tokens ?? 0) });
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

    // 我的充值码兑换记录（只展示已兑换的；不含明文码/哈希，安全）
    .get('/api/redeem/history', query(paginationQuerySchema), async (c) => {
      const session = c.get('session');
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const where = and(eq(redeemCodes.usedBy, session.userId), eq(redeemCodes.status, 1));
      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: redeemCodes.id,
            amount: redeemBatches.amount,
            batchName: redeemBatches.name,
            usedAt: redeemCodes.usedAt,
          })
          .from(redeemCodes)
          .innerJoin(redeemBatches, eq(redeemCodes.batchId, redeemBatches.id))
          .where(where)
          .orderBy(desc(redeemCodes.usedAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(redeemCodes).where(where),
      ]);
      return c.json(paginatedResult(rows, Number(countRows[0]?.count ?? 0), p));
    })

    // 兑换充值码
    .post('/api/redeem', jsonBody(redeemSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');
      // P-1 修复：兑换限流（防脚本爆破充值码，10 次/分钟）
      const redis = getSharedRedis();
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
      const r = await redeemCode(db, session.userId, body.code, getSharedRedis());
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
        db
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
          .orderBy(desc(usageLogs.createdAt))
          .limit(limit)
          .offset(offset),
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
    })

    // 用量按模型聚合（图表用：不同模型的使用量分布）
    .get('/api/usage/by-model', query(z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    })), async (c) => {
      const session = c.get('session');
      const q = c.req.valid('query');
      const conds = [eq(usageLogs.userId, session.userId)];
      // 默认近 30 天（避免全量；from 未传时回退 30 天前）
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400_000);
      conds.push(gte(usageLogs.createdAt, from));
      if (q.to) conds.push(lte(usageLogs.createdAt, new Date(q.to)));
      const where = and(...conds);
      // 按模型聚合：requests / input_tokens / output_tokens / cost
      const rows = await db
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
      return c.json({
        list: rows.map((r) => ({
          model: r.model,
          requests: Number(r.requests),
          inputTokens: Number(r.inputTokens),
          outputTokens: Number(r.outputTokens),
          cachedInputTokens: Number(r.cachedInputTokens),
          cost: Number(r.cost),
        })),
      });
    });
}
