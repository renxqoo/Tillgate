/**
 * 订阅管理动词路由（v1 routes/subscriptions.ts 动词面平移）：续费/变更/取消/加油包
 * 发放。资金动词幂等键经 operationId（http 货架）;管理面 userId:null 直续免属主检查
 * （billing 语义）。GET /v1/subscriptions（管理列表）为 P1 pending（DESIGN §5 D7）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { SubscriptionsApi } from '@tokenlens/billing';
import { operationId } from '@tokenlens/http';
import type { SessionEnv } from '../middleware/session';
import { idParam } from '../contracts/common';
import { subscriptionsContracts } from '../contracts/subscriptions';

export interface SubscriptionsRoutesDeps {
  readonly subscriptions: SubscriptionsApi;
}

export function subscriptionsRoutes(
  deps: SubscriptionsRoutesDeps,
  session: MiddlewareHandler<SessionEnv>,
) {
  const app = new Hono<SessionEnv>();

  app.post('/v1/subscriptions/:id/renew', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(
      await deps.subscriptions.renew({
        operationId: operationId(c),
        userId: null,
        subscriptionId: id,
      }),
    );
  });

  app.post('/v1/subscriptions/:id/change', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = subscriptionsContracts.change.parse(await c.req.json());
    return c.json(
      await deps.subscriptions.change({
        operationId: operationId(c),
        userId: null,
        subscriptionId: id,
        targetPlanId: body.targetPlanId,
        quantity: body.quantity,
      }),
    );
  });

  app.post('/v1/subscriptions/:id/cancel', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(
      await deps.subscriptions.cancel({ operationId: operationId(c), subscriptionId: id }),
    );
  });

  app.post('/v1/subscriptions/:id/grant', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = subscriptionsContracts.grant.parse(await c.req.json());
    return c.json(
      await deps.subscriptions.grantPack({
        operationId: operationId(c),
        userId: body.userId,
        packId: id,
      }),
    );
  });

  return app;
}
