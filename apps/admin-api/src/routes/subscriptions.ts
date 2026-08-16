import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { plans, users, userSubscriptions } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  intParam,
  jsonBody,
  operationId,
  paginateQuery,
  query,
  listQuerySchema,
  buildList,
  countAll,
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

const subListQuerySchema = listQuerySchema.extend({
  planId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  status: z.coerce.number().int().min(0).max(2).optional(),
});

/** 席位上限：与用户自助变更同口径，防 numeric 溢出 */
const SEATS_MAX = 1000;

const changeSchema = z.object({
  targetPlanId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(SEATS_MAX),
});

export function subscriptionAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()
    .get('/', query(subListQuerySchema), async (c) => {
      const q = c.req.valid('query');
      const { page, limit, offset, where, orderBy } = buildList(q, {
        search: [users.subject, users.displayName, plans.name],
        conditions: [
          q.planId ? eq(userSubscriptions.planId, q.planId) : undefined,
          q.userId ? eq(userSubscriptions.userId, q.userId) : undefined,
          q.status !== undefined ? eq(userSubscriptions.status, q.status) : undefined,
        ],
        sort: {
          by: {
            id: userSubscriptions.id,
            createdAt: userSubscriptions.createdAt,
            startAt: userSubscriptions.startAt,
            endAt: userSubscriptions.endAt,
            usedAmount: userSubscriptions.usedAmount,
          },
          fallback: 'createdAt',
          tiebreaker: userSubscriptions.id,
        },
      });
      const result = await paginateQuery(
        page,
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
            quantity: userSubscriptions.quantity,
            price: userSubscriptions.price,
            /** 剩余额度（元）= 额度 - 已用 - 在途预占，与网关授权口径一致 */
            remainingAmount: sql<string>`${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} - ${userSubscriptions.reservedAmount}`,
            status: userSubscriptions.status,
            createdAt: userSubscriptions.createdAt,
          })
          .from(userSubscriptions)
          .innerJoin(plans, eq(userSubscriptions.planId, plans.id))
          .innerJoin(users, eq(userSubscriptions.userId, users.id))
          .where(where)
          .orderBy(...orderBy)
          .limit(limit)
          .offset(offset),
        countAll(s.db, userSubscriptions, where, [
          { table: plans, on: eq(userSubscriptions.planId, plans.id) },
          { table: users, on: eq(userSubscriptions.userId, users.id) },
        ]),
      );
      return c.json(result);
    })

    .post('/:id/renew', async (c) => {
      const id = intParam(c, 'id');
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

    .post('/:id/change', jsonBody(changeSchema), async (c) => {
      const id = intParam(c, 'id');
      const body = c.req.valid('json');
      try {
        const result = await s.ledger.changeSubscription({
          operationId: operationId(c),
          subscriptionId: id,
          targetPlanId: body.targetPlanId,
          quantity: body.quantity,
          adminId: c.get('adminId'),
        });
        return c.json(result);
      } catch (error) {
        throw mapSubscriptionError(error);
      }
    })

    .post('/:id/cancel', async (c) => {
      const id = intParam(c, 'id');
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
