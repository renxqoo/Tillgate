import { Hono } from 'hono';
import { eq, and, sql, gte, lte, desc, gt, isNull } from 'drizzle-orm';
import { users, rateCards, transactions, userSubscriptions, plans } from '@ai-gateway/db/schema';
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
          isEnterprise: users.isEnterprise,
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

    // 当前订阅（套餐/生效期/剩余额度），无有效订阅返回 null
    .get('/subscription', async (c) => {
      const session = c.get('session');
      const rows = await s.db
        .select({
          id: userSubscriptions.id,
          planId: userSubscriptions.planId,
          planName: plans.name,
          planSortOrder: plans.sortOrder,
          allowSeats: plans.allowSeats,
          quantity: userSubscriptions.quantity,
          startAt: userSubscriptions.startAt,
          endAt: userSubscriptions.endAt,
          quotaAmount: userSubscriptions.quotaAmount,
          usedAmount: userSubscriptions.usedAmount,
          reservedAmount: userSubscriptions.reservedAmount,
          price: userSubscriptions.price,
          /** 剩余额度（元）= 额度 - 已用 - 在途预占，与网关授权口径一致 */
          remainingAmount: sql<string>`${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} - ${userSubscriptions.reservedAmount}`,
          periodDays: plans.periodDays,
          /** 续费总价（当前档价 × 席位），供前端确认弹窗展示 */
          renewPrice: sql<string>`${plans.price} * ${userSubscriptions.quantity}::numeric`,
          /** 当前档单价（元/席），供升级/加席位弹窗算补差价 */
          planPrice: plans.price,
          /** 剩余价值（元）= 总价 × (额度-已用-在途)/额度，与变更补差价同口径 */
          remainingValue: sql<string>`CASE WHEN ${userSubscriptions.quotaAmount} > 0 THEN ${userSubscriptions.price} * (${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} - ${userSubscriptions.reservedAmount}) / ${userSubscriptions.quotaAmount} ELSE 0 END`,
        })
        .from(userSubscriptions)
        .innerJoin(plans, eq(userSubscriptions.planId, plans.id))
        .where(
          and(
            eq(userSubscriptions.userId, session.userId),
            // 只返回「个人订阅」；组织订阅（org_id 非空）归 /api/orgs 展示。
            isNull(userSubscriptions.orgId),
            eq(userSubscriptions.status, 0),
            gt(userSubscriptions.endAt, new Date()),
          ),
        )
        .orderBy(desc(userSubscriptions.id))
        .limit(1);
      if (rows.length === 0) return c.json(null);
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
      // 显式列（T6）：select() 全列会把 transactions.created_by（操作管理员 id）泄给终端用户
      const txColumns = {
        id: transactions.id,
        userId: transactions.userId,
        type: transactions.type,
        amount: transactions.amount,
        balanceBefore: transactions.balanceBefore,
        balanceAfter: transactions.balanceAfter,
        refType: transactions.refType,
        refId: transactions.refId,
        remark: transactions.remark,
        createdAt: transactions.createdAt,
      };
      const result = await paginateQuery(
        p,
        s.db.select(txColumns).from(transactions).where(where).orderBy(desc(transactions.createdAt)).limit(limit).offset(offset),
        s.db.select({ count: sql<number>`count(*)::int` }).from(transactions).where(where),
      );
      return c.json(result);
    });
}
