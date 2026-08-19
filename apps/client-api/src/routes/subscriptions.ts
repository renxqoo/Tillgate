/**
 * 套餐/订阅路由：目录（公开）+ 购买/变更/续费/我的订阅（会话）。
 * 席位上界 1000：防 numeric 溢出与恶意超大值（超此规模走线下）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { SubscriptionService } from '../services/subscription.service.js';

const SEATS_MAX = 1000;

const purchaseSchema = z.object({
  planId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(SEATS_MAX).optional(),
});

const changeSchema = z.object({
  targetPlanId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(SEATS_MAX),
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function subscriptionRoutes(
  service: SubscriptionService,
  session: MiddlewareHandler<SessionEnv>,
) {
  const app = new Hono<SessionEnv>();

  // 目录公开（只读上架套餐，无个人数据）
  app.get('/v1/plans', async (c) => {
    const plans = await service.listPlans({
      requestId: c.get('requestId'),
      actor: { kind: 'system' },
      traceParent: null,
    });
    return c.json({ rows: plans });
  });

  app.get('/v1/subscriptions', session, async (c) => {
    const rows = await service.mySubscriptions(userCtxOf(c), c.get('userId'));
    return c.json({ rows });
  });

  app.post('/v1/subscriptions', session, async (c) => {
    const body = purchaseSchema.parse(await c.req.json());
    const result = await service.purchase(userCtxOf(c), c.get('userId'), {
      idempotencyKey: c.req.header('idempotency-key'),
      ...body,
    });
    return c.json(result, 201);
  });

  app.post('/v1/subscriptions/:id/change', session, async (c) => {
    const { id } = idParamSchema.parse(c.req.param());
    const body = changeSchema.parse(await c.req.json());
    const result = await service.change(userCtxOf(c), c.get('userId'), {
      idempotencyKey: c.req.header('idempotency-key'),
      subscriptionId: id,
      ...body,
    });
    return c.json(result);
  });

  app.post('/v1/subscriptions/:id/renew', session, async (c) => {
    const { id } = idParamSchema.parse(c.req.param());
    const result = await service.renew(userCtxOf(c), c.get('userId'), {
      idempotencyKey: c.req.header('idempotency-key'),
      subscriptionId: id,
    });
    return c.json(result);
  });

  return app;
}
