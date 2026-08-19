/**
 * 通知渠道路由（会话）：列表 / 创建 / 更新 / 删除 / 测试事件入箱。
 * webhook 需 url+secret；email 需 recipients（服务层校验）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { adminCtxOf } from './ctx.js';
import { AppError } from '../http/error-map.js';
import { NOTIFY_EVENTS, type NotificationsService } from '../services/notifications.service.js';
import type { SessionEnv } from '../middleware/session.js';

const configSchema = z
  .object({
    url: z.string().url().max(255).optional(),
    secret: z.string().min(16).max(255).optional(),
    recipients: z.array(z.string().email().max(255)).max(20).optional(),
  })
  .refine((cfg) => (cfg.url && cfg.secret) || (cfg.recipients && cfg.recipients.length > 0), {
    message: 'webhook 需 url+secret；email 需 recipients',
  });

const channelSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(['webhook', 'email']),
  config: configSchema,
  events: z.array(z.enum(NOTIFY_EVENTS)).min(1),
  status: z.number().int().min(0).max(1).optional(),
});

const updateSchema = channelSchema.partial().extend({
  /** 类型不可改（config 口径与类型绑定） */
  type: z.never().optional(),
});

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, 'invalid_param', '路径参数 id 必须为正整数');
  }
  return id;
};

export function notificationsRoutes(
  service: NotificationsService,
  session: MiddlewareHandler<SessionEnv>,
) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/notifications', session, async (c) => {
    return c.json(await service.list(adminCtxOf(c)));
  });

  app.post('/v1/notifications', session, async (c) => {
    const body = channelSchema.parse(await c.req.json());
    const row = await service.create(adminCtxOf(c), body);
    return c.json(row, 201);
  });

  app.patch('/v1/notifications/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = updateSchema.parse(await c.req.json());
    return c.json(await service.patch(adminCtxOf(c), { channelId: id, patch: body }));
  });

  app.delete('/v1/notifications/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await service.remove(adminCtxOf(c), id));
  });

  app.post('/v1/notifications/:id/test', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await service.test(adminCtxOf(c), id));
  });

  return app;
}
