/**
 * 供应商路由（v1 routes/providers.ts 平移）：列表/创建/更新/软退役。
 * 数值域铁三角在 zod 层收口;协议/档案词表校验在 control-plane。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { ControlPlane } from '@tokenlens/control-plane';
import type { SessionEnv } from '../middleware/session';
import { controlContextOf } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { PROVIDER_SORTS, providersContracts } from '../contracts/control-plane';
import { toProviderWireRow } from '../presenters/control-plane';

export interface ProvidersRoutesDeps {
  readonly controlPlane: Pick<ControlPlane, 'providers'>;
}

export function providersRoutes(deps: ProvidersRoutesDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();
  const providers = deps.controlPlane.providers;

  app.get('/v1/providers', session, async (c) => {
    const query = parseListQuery(c.req.query(), PROVIDER_SORTS, 'createdAt');
    const result = await providers.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'name' | 'status' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(result.rows.map(toProviderWireRow), result.total, query));
  });

  app.post('/v1/providers', session, async (c) => {
    const body = providersContracts.create.parse(await c.req.json());
    const row = await providers.create({ ctx: controlContextOf(c), ...body });
    return c.json(toProviderWireRow(row), 201);
  });

  app.patch('/v1/providers/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const patch = providersContracts.update.parse(await c.req.json());
    const row = await providers.update({ ctx: controlContextOf(c), providerId: id, patch });
    return c.json(toProviderWireRow(row));
  });

  app.delete('/v1/providers/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await providers.retire({ ctx: controlContextOf(c), providerId: id }));
  });

  return app;
}
