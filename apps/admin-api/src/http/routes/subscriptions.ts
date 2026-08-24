/**
 * 订阅管理动词路由（v1 routes/subscriptions.ts 动词面平移）：续费/变更/取消/加油包
 * 发放。资金动词幂等键经 operationId（http 货架）;管理面 userId:null 直续免属主检查
 * （billing 语义）。GET /v1/subscriptions（管理列表）为 P1 pending（DESIGN §5 D7）。
 */
import { Hono } from 'hono';
import type { SubscriptionsApi } from '@tillgate/billing';
import { operationId } from '@tillgate/http';
import type { SessionEnv } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { subscriptionsContracts } from '../contracts/subscriptions';
import { toSubscriptionWireRow } from '../presenters/billing';

export interface SubscriptionsRoutesDeps {
  readonly subscriptions: SubscriptionsApi;
}

export function subscriptionsRoutes(deps: SubscriptionsRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/subscriptions', async (c) => {
    const raw = c.req.query();
    const extra = {
      planId: raw.planId !== undefined ? Number(raw.planId) : undefined,
      userId: raw.userId !== undefined ? Number(raw.userId) : undefined,
      status: raw.status !== undefined ? Number(raw.status) : undefined,
    };
    const query = parseListQuery(
      raw,
      ['id', 'createdAt', 'startAt', 'endAt', 'usedAmount'],
      'createdAt',
    );
    const page = await deps.subscriptions.adminList({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(extra.planId !== undefined && Number.isInteger(extra.planId)
        ? { planId: extra.planId }
        : {}),
      ...(extra.userId !== undefined && Number.isInteger(extra.userId)
        ? { userId: extra.userId }
        : {}),
      ...(extra.status !== undefined && Number.isInteger(extra.status)
        ? { status: extra.status }
        : {}),
      sortBy: query.sortBy as 'id' | 'createdAt' | 'startAt' | 'endAt' | 'usedAmount',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(page.rows.map(toSubscriptionWireRow), page.total, query));
  });

  app.post('/v1/subscriptions/:id/renew', async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(
      await deps.subscriptions.renew({
        operationId: operationId(c),
        userId: null,
        subscriptionId: id,
      }),
    );
  });

  app.post('/v1/subscriptions/:id/change', async (c) => {
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

  app.post('/v1/subscriptions/:id/cancel', async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(
      await deps.subscriptions.cancel({ operationId: operationId(c), subscriptionId: id }),
    );
  });

  app.post('/v1/subscriptions/:id/grant', async (c) => {
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
