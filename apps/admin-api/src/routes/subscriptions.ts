/**
 * 订阅管理面路由（会话）：列表（用户/套餐 join + 剩余额度）/ 续费 / 变更 /
 * 取消 / 加油包发放。资金动词走共享订阅域（幂等键透传）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { operationId } from '@ai-gateway/http';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import { SUBSCRIPTION_SORTS, type AdminSubscriptionsService } from '../services/subscriptions.service.js';
import type { SessionEnv } from '../middleware/session.js';

const SEATS_MAX = 1000;

const listQueryExtra = z.object({
  planId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  status: z.coerce.number().int().min(0).max(2).optional(),
});

const changeSchema = z.object({
  targetPlanId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(SEATS_MAX).default(1),
});

const grantSchema = z.object({ userId: z.number().int().positive() });

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, 'invalid_param', 'Path parameter id must be a positive integer');
  }
  return id;
};

export function adminSubscriptionsRoutes(
  service: AdminSubscriptionsService,
  session: MiddlewareHandler<SessionEnv>,
) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/subscriptions', session, async (c) => {
    const extra = listQueryExtra.parse(c.req.query());
    const query = parseListQuery(c.req.query(), SUBSCRIPTION_SORTS, 'createdAt');
    return c.json(await service.list(adminCtxOf(c), { query, ...extra }));
  });

  app.post('/v1/subscriptions/:id/renew', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(
      await service.renew(adminCtxOf(c), {
        adminId: c.get('adminId'),
        subscriptionId: id,
        operationId: operationId(c),
      }),
    );
  });

  app.post('/v1/subscriptions/:id/change', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = changeSchema.parse(await c.req.json());
    return c.json(
      await service.change(adminCtxOf(c), {
        adminId: c.get('adminId'),
        subscriptionId: id,
        targetPlanId: body.targetPlanId,
        quantity: body.quantity,
        operationId: operationId(c),
      }),
    );
  });

  app.post('/v1/subscriptions/:id/cancel', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(
      await service.cancel(adminCtxOf(c), {
        adminId: c.get('adminId'),
        subscriptionId: id,
        operationId: operationId(c),
      }),
    );
  });

  app.post('/v1/subscriptions/:id/grant', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = grantSchema.parse(await c.req.json());
    return c.json(
      await service.grantPack(adminCtxOf(c), {
        adminId: c.get('adminId'),
        userId: body.userId,
        packId: id,
        operationId: operationId(c),
      }),
    );
  });

  return app;
}
