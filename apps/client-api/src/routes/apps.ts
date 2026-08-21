/**
 * Apps 路由（会话）：列表 / 创建（client_secret 仅此一次）/ 禁用 / 轮换密钥。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { AppsService } from '../services/apps.service.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().max(255).optional().nullable(),
  subscriptionId: z.number().int().positive().optional().nullable(),
  scope: z
    .object({
      models: z.array(z.string().max(64)).max(100).optional(),
      rpm: z.number().int().positive().max(1_000_000).optional(),
      tpm: z.number().int().positive().max(100_000_000).optional(),
    })
    .optional()
    .nullable(),
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export function appsRoutes(service: AppsService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/apps', session, async (c) => {
    const query = listQuerySchema.parse(c.req.query());
    const result = await service.list(userCtxOf(c), c.get('userId'), query);
    return c.json({ rows: result.rows, total: result.total, page: query.page, limit: query.limit });
  });

  app.post('/v1/apps', session, async (c) => {
    const body = createSchema.parse(await c.req.json());
    const result = await service.create(userCtxOf(c), c.get('userId'), body);
    return c.json(result, 201);
  });

  app.post('/v1/apps/:id/disable', session, async (c) => {
    const { id } = idParamSchema.parse(c.req.param());
    await service.disable(userCtxOf(c), c.get('userId'), id);
    return c.json({ id });
  });

  app.post('/v1/apps/:id/rotate', session, async (c) => {
    const { id } = idParamSchema.parse(c.req.param());
    const result = await service.rotateSecret(userCtxOf(c), c.get('userId'), id);
    return c.json(result);
  });


  return app;
}
