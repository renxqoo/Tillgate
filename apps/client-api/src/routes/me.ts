import { Hono } from 'hono';
import { eq, and, sql, gte, lte, desc } from 'drizzle-orm';
import { users, rateCards, transactions } from '@ai-gateway/db/schema';
import { z } from 'zod';
import { HttpError, limitOffset, paginateQuery, paginationQuerySchema, parsePagination, query } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';

/**
 * 用户面板：当前用户信息与资金流水（api-contract §4.1 / §4.3）。
 *
 *   - GET /：当前用户信息（余额、费率卡、状态）
 *   - GET /transactions：自己的资金流水（分页 + 时间范围）
 */

const txQuerySchema = paginationQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export function meRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 当前用户信息
    .get('/', async (c) => {
      const session = c.get('session');
      const rows = await s.db
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
      if (rows.length === 0) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在');
      return c.json(rows[0]);
    })

    // 资金流水
    .get('/transactions', query(txQuerySchema), async (c) => {
      const session = c.get('session');
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const conds = [eq(transactions.userId, session.userId)];
      if (q.from) conds.push(gte(transactions.createdAt, new Date(q.from)));
      if (q.to) conds.push(lte(transactions.createdAt, new Date(q.to)));
      const where = and(...conds);
      const result = await paginateQuery(
        p,
        s.db.select().from(transactions).where(where).orderBy(desc(transactions.createdAt)).limit(limit).offset(offset),
        s.db.select({ count: sql<number>`count(*)::int` }).from(transactions).where(where),
      );
      return c.json(result);
    });
}
