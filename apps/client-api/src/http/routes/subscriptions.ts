/**
 * 套餐/订阅路由：目录（公开）+ 购买/变更/续费/我的订阅（会话）。
 * 幂等键：idempotency-key 头缺省服务端生成 uuid；非法形态 400（v1 口径）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { randomUUID } from 'node:crypto';
import { HttpErrors, jsonBody } from '@tokenlens/http';
import type { SubscriptionsApi } from '@tokenlens/billing';
import {
  IDEMPOTENCY_KEY_PATTERN,
  planChangeSchema,
  purchaseSchema,
  subscriptionIdParamSchema,
} from '../contracts/billing.js';
import { toMySubscriptionRow, type PlanRow, type SubscriptionBaseRow } from '../presenters/subscriptions.js';
import { parsePath } from '../contracts/shared.js';
import type { SessionEnv } from '../middleware/session.js';

export interface SubscriptionReads {
  readonly listPlans: () => Promise<readonly PlanRow[]>;
  readonly mySubscriptions: (userId: number) => Promise<readonly SubscriptionBaseRow[]>;
}

export interface SubscriptionsDeps {
  readonly api: Pick<SubscriptionsApi, 'purchase' | 'change' | 'renew'>;
  readonly reads: SubscriptionReads;
}

function operationIdOf(headerValue: string | undefined): string {
  if (headerValue == null || headerValue === '') return randomUUID();
  if (!IDEMPOTENCY_KEY_PATTERN.test(headerValue)) {
    throw HttpErrors.business('invalid_idempotency_key');
  }
  return headerValue;
}

export function subscriptionRoutes(deps: SubscriptionsDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  // 目录公开（只读上架套餐，无个人数据）
  app.get('/v1/plans', async (c) => {
    const rows = await deps.reads.listPlans();
    return c.json({ rows });
  });

  app.get('/v1/subscriptions', session, async (c) => {
    const rows = await deps.reads.mySubscriptions(c.get('userId'));
    return c.json({ rows: rows.map(toMySubscriptionRow) });
  });

  app.post('/v1/subscriptions', session, jsonBody(purchaseSchema), async (c) => {
    const body = c.req.valid('json');
    const result = await deps.api.purchase({
      operationId: operationIdOf(c.req.header('idempotency-key')),
      userId: c.get('userId'),
      planId: body.planId,
      quantity: body.quantity,
      ensureOrg: true,
    });
    return c.json(result, 201);
  });

  app.post('/v1/subscriptions/:id/change', session, jsonBody(planChangeSchema), async (c) => {
    const { id } = parsePath(subscriptionIdParamSchema, c.req.param());
    const body = c.req.valid('json');
    const result = await deps.api.change({
      operationId: operationIdOf(c.req.header('idempotency-key')),
      userId: c.get('userId'),
      subscriptionId: id,
      targetPlanId: body.targetPlanId,
      quantity: body.quantity,
    });
    return c.json(result);
  });

  app.post('/v1/subscriptions/:id/renew', session, async (c) => {
    const { id } = parsePath(subscriptionIdParamSchema, c.req.param());
    const result = await deps.api.renew({
      operationId: operationIdOf(c.req.header('idempotency-key')),
      userId: c.get('userId'),
      subscriptionId: id,
    });
    return c.json(result);
  });

  return app;
}
