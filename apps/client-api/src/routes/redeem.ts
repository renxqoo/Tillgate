import { Hono } from 'hono';
import { eq, and, sql, desc } from 'drizzle-orm';
import { redeemCodes, redeemBatches } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { jsonBody, limitOffset, paginateQuery, paginationQuerySchema, parsePagination, query } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';
import { redeemCode } from '../services/redeem.js';

/**
 * 用户面板：充值码兑换（api-contract §4.1）。
 *
 *   - POST /：兑换充值码（限流 10 次/分钟，ledger 事务幂等）
 *   - GET /history：我的兑换记录（只展示已兑换的；不含明文码/哈希，安全）
 */

const redeemSchema = z.object({ code: z.string().min(1).max(64) });

export function redeemRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 兑换充值码
    .post('/', jsonBody(redeemSchema), async (c) => {
      const session = c.get('session');
      const body = c.req.valid('json');
      const outcome = await redeemCode(s, session.userId, body.code);

      switch (outcome.kind) {
        case 'rate_limited':
          c.header('retry-after', String(outcome.retryAfterSec));
          return c.json({ error: { message: '兑换过于频繁，请稍后再试', code: 'RATE_LIMITED' } }, 429);
        case 'rejected': {
          // 错误码 → HTTP 状态（api-contract §4.1）：已使用 → 409，其余 → 400
          const status: 400 | 409 = outcome.reason === 'code_already_used' ? 409 : 400;
          return c.json({ error: { message: outcome.reason, code: outcome.reason } }, status);
        }
        case 'success':
          return c.json({ ok: true, amount: outcome.amount, balanceAfter: outcome.balanceAfter });
      }
    })

    // 我的兑换记录（已兑换的；不含明文码/哈希）
    .get('/history', query(paginationQuerySchema), async (c) => {
      const session = c.get('session');
      const p = parsePagination(c.req.valid('query'));
      const { limit, offset } = limitOffset(p);
      const where = and(eq(redeemCodes.usedBy, session.userId), eq(redeemCodes.status, 1));
      const result = await paginateQuery(
        p,
        s.db
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
        s.db.select({ count: sql<number>`count(*)::int` }).from(redeemCodes).where(where),
      );
      return c.json(result);
    });
}
