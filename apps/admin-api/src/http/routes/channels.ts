/**
 * 渠道路由（v1 routes/channels.ts 平移）：列表（富化）/创建/更新（换 Key 复位运行态）/
 * 软退役/批量导入（best-effort）/连通性探针。apiKey 加密落库（control-plane cipher）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { ControlPlane } from '@tokenlens/control-plane';
import type { SessionEnv } from '../middleware/session';
import { controlContextOf } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { CHANNEL_SORTS, channelsContracts } from '../contracts/control-plane';
import { toChannelWireRow } from '../presenters/control-plane';

export interface ChannelsRoutesDeps {
  readonly controlPlane: Pick<ControlPlane, 'channels'>;
}

export function channelsRoutes(deps: ChannelsRoutesDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();
  const channels = deps.controlPlane.channels;

  app.get('/v1/channels', session, async (c) => {
    const query = parseListQuery(c.req.query(), CHANNEL_SORTS, 'createdAt');
    const result = await channels.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'name' | 'status' | 'priority' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(result.rows.map(toChannelWireRow), result.total, query));
  });

  app.post('/v1/channels', session, async (c) => {
    const body = channelsContracts.create.parse(await c.req.json());
    const row = await channels.create({ ctx: controlContextOf(c), ...body });
    return c.json(row, 201);
  });

  app.patch('/v1/channels/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = channelsContracts.update.parse(await c.req.json());
    const row = await channels.update({ ctx: controlContextOf(c), channelId: id, patch: body });
    return c.json(row);
  });

  app.delete('/v1/channels/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await channels.retire({ ctx: controlContextOf(c), channelId: id }));
  });

  app.post('/v1/channels/import', session, async (c) => {
    const body = channelsContracts.import.parse(await c.req.json());
    const result = await channels.import({ ctx: controlContextOf(c), channels: body.channels });
    return c.json(result, result.success > 0 ? 200 : 400);
  });

  app.post('/v1/channels/:id/test', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await channels.probe(id));
  });

  return app;
}
