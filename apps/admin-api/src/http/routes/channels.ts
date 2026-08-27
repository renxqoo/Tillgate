/**
 * 渠道路由（含逻辑删除回收站）：列表（富化 / view=deleted
 * 回收站）/创建/更新（换 Key 复位运行态）/逻辑删除（在册绑定守卫）/恢复记录/
 * 批量导入（best-effort）/连通性探针。apiKey 加密落库（control-plane cipher）。
 */
import { Hono } from 'hono';
import type { ControlPlane } from '@tillgate/control-plane';
import type { SessionEnv } from '../middleware/session';
import { controlContextOf } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { CHANNEL_SORTS, channelsContracts } from '../contracts/control-plane';
import { toChannelWireRow } from '../presenters/control-plane';

export interface ChannelsRoutesDeps {
  readonly controlPlane: Pick<ControlPlane, 'channels'>;
}

// eslint-disable-next-line max-lines-per-function -- 路由表装配平铺:注册即数据,内联处理器保留存量语义(棘轮)
export function channelsRoutes(deps: ChannelsRoutesDeps) {
  const app = new Hono<SessionEnv>();
  const { channels } = deps.controlPlane;

  app.get('/v1/channels', async (c) => {
    const query = parseListQuery(c.req.query(), CHANNEL_SORTS, 'createdAt');
    // 回收站视图：仅认 'deleted'，其余值容错回退默认在册视图（列表参数永不 400）
    const view = c.req.query('view') === 'deleted' ? ('deleted' as const) : undefined;
    const result = await channels.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'name' | 'status' | 'priority' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
      ...(view !== undefined ? { view } : {}),
    });
    return c.json(listEnvelope(result.rows.map(toChannelWireRow), result.total, query));
  });

  app.post('/v1/channels', async (c) => {
    const body = channelsContracts.create.parse(await c.req.json());
    const row = await channels.create({ ctx: controlContextOf(c), ...body });
    return c.json(row, 201);
  });

  app.patch('/v1/channels/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = channelsContracts.update.parse(await c.req.json());
    const row = await channels.update({ ctx: controlContextOf(c), channelId: id, patch: body });
    return c.json(row);
  });

  app.delete('/v1/channels/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await channels.delete({ ctx: controlContextOf(c), channelId: id }));
  });

  /** 恢复已删除记录（回收站取出，回停用态）；在册行调用 → 404 */
  app.post('/v1/channels/:id/restore', async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await channels.undelete({ ctx: controlContextOf(c), channelId: id }));
  });

  app.post('/v1/channels/import', async (c) => {
    const body = channelsContracts.import.parse(await c.req.json());
    const result = await channels.import({ ctx: controlContextOf(c), channels: body.channels });
    return c.json(result, result.success > 0 ? 200 : 400);
  });

  app.post('/v1/channels/:id/test', async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await channels.probe(id));
  });

  return app;
}
