/**
 * 通知渠道路由：列表/创建/更新/删除/测试入箱。
 * 渠道 CRUD 与测试动词全部经 @tillgate/notifications facade（业务校验/加密/掩码在包内）;
 * 实际投递由 worker dispatchOnce 消费——本面只管理 + 入箱测试事件。
 */
import { Hono } from 'hono';
import type { Notifications } from '@tillgate/notifications';
import type { SessionEnv } from '../middleware/session';
import { idParam } from '../contracts/common';
import { notificationsContracts } from '../contracts/notifications';

export interface NotificationsRoutesDeps {
  readonly notifications: Pick<Notifications, 'channels'>;
}

/** HTTP 请求 → notifications 用例上下文（actor=admin） */
function notifyContextOf(c: { get: (k: 'requestId' | 'adminId') => unknown }) {
  return {
    requestId: c.get('requestId') as string,
    actor: { kind: 'admin' as const, id: c.get('adminId') as number },
  };
}

export function notificationsRoutes(deps: NotificationsRoutesDeps) {
  const app = new Hono<SessionEnv>();
  const { channels } = deps.notifications;

  app.get('/v1/notifications', async (c) => c.json(await channels.list()));

  app.post('/v1/notifications', async (c) => {
    const body = notificationsContracts.create.parse(await c.req.json());
    const row = await channels.create({
      ctx: notifyContextOf(c),
      name: body.name,
      type: body.type,
      config: body.config,
      events: body.events,
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    return c.json(row, 201);
  });

  app.patch('/v1/notifications/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = notificationsContracts.update.parse(await c.req.json());
    return c.json(
      await channels.patch({
        ctx: notifyContextOf(c),
        channelId: id,
        patch: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.config !== undefined ? { config: body.config } : {}),
          ...(body.events !== undefined ? { events: body.events } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        },
      }),
    );
  });

  app.delete('/v1/notifications/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await channels.remove({ ctx: notifyContextOf(c), channelId: id }));
  });

  app.post('/v1/notifications/:id/test', async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await channels.test({ ctx: notifyContextOf(c), channelId: id }));
  });

  return app;
}
