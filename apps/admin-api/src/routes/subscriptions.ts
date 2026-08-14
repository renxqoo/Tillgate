import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { plans, users, userSubscriptions } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  limitOffset,
  operationId,
  paginateQuery,
  paginationQuerySchema,
  parsePagination,
  query,
} from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { mapSubscriptionError } from '../services/subscriptions.js';

/**
 * 订阅管理（api-contract §4.10）。
 *
 *   - GET /：订阅列表（联套餐名 + 用户，支持 plan_id/status 筛选 + 分页）
 *   - POST /:id/renew：续费（扣余额、旧订阅转到期、新订阅顺延）
 *   - POST /:id/cancel：取消（剩余额度作废，不退款）
 */

const subListQuerySchema = paginationQuerySchema.extend({
  planId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  status: z.coerce.number().int().min(0).max(2).optional(),
});

export function subscriptionAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    .get('/', query(subListQuerySchema), async (c) => {
      const q = c.req.valid('query');
      const p = parsePagination(q);
      const { limit, offset } = limitOffset(p);
      const conds = [];
      if (q.planId) conds.push(eq(userSubscriptions.planId, q.planId));
      if (q.userId) conds.push(eq(userSubscriptions.userId, q.userId));
      if (q.status !== undefined) conds.push(eq(userSubscriptions.status, q.status));
      const where = conds.length > 0 ? and(...conds) : undefined;
      const result = await paginateQuery(
        p,
        s.db
          .select({
            id: userSubscriptions.id,
            userId: userSubscriptions.userId,
            userSubject: users.subject,
            userDisplayName: users.displayName,
            planId: userSubscriptions.planId,
            planName: plans.name,
            startAt: userSubscriptions.startAt,
            endAt: userSubscriptions.endAt,
            quotaAmount: userSubscriptions.quotaAmount,
            usedAmount: userSubscriptions.usedAmount,
            reservedAmount: userSubscriptions.reservedAmount,
            remainingAmount: sql<string>`${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount}`,
            status: userSubscriptions.status,
            createdAt: userSubscriptions.createdAt,
          })
          .from(userSubscriptions)
          .innerJoin(plans, eq(userSubscriptions.planId, plans.id))
          .innerJoin(users, eq(userSubscriptions.userId, users.id))
          .where(where)
          .orderBy(desc(userSubscriptions.createdAt))
          .limit(limit)
          .offset(offset),
        s.db
          .select({ count: sql<number>`count(*)::int` })
          .from(userSubscriptions)
          .where(where),
      );
      return c.json(result);
    })

    .post('/:id/renew', async (c) => {
      const id = Number(c.req.param('id'));
      try {
        const result = await s.ledger.renewSubscription({
          operationId: operationId(c),
          subscriptionId: id,
          adminId: c.get('adminId'),
        });
        return c.json(result);
      } catch (error) {
        throw mapSubscriptionError(error);
      }
    })

    .post('/:id/cancel', async (c) => {
      const id = Number(c.req.param('id'));
      try {
        const result = await s.ledger.cancelSubscription({
          operationId: operationId(c),
          subscriptionId: id,
          adminId: c.get('adminId'),
        });
        return c.json(result);
      } catch (error) {
        throw mapSubscriptionError(error);
      }
    });
}
