/**
 * 供应商路由（会话）：列表 / 创建 / 更新 / 软退役。
 * 数值域铁三角在 zod 层收口：URL 形状/长度上界；协议词表校验在 service。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { adminCtxOf } from './ctx.js';
import { parseListQuery } from '../http/list-query.js';
import { AppError } from '../http/error-map.js';
import { PROVIDER_SORTS, type ProvidersService } from '../services/providers.service.js';
import type { SessionEnv } from '../middleware/session.js';

const createSchema = z.object({
  name: z.string().min(1).max(32),
  protocol: z.string().max(32).optional(),
  /** 厂商档案引用（VENDOR_PROFILES 词表；null/空串 = 清除（纯透传）） */
  vendor: z.string().max(32).nullable().optional(),
  baseUrl: z.string().url().max(255),
  status: z.number().int().min(0).max(1).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  protocol: z.string().max(32).optional(),
  vendor: z.string().max(32).nullable().optional(),
  baseUrl: z.string().url().max(255).optional(),
  status: z.number().int().min(0).max(1).optional(),
});

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, 'invalid_param', 'Path parameter id must be a positive integer');
  }
  return id;
};

export function providersRoutes(service: ProvidersService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/providers', session, async (c) => {
    const query = parseListQuery(c.req.query(), PROVIDER_SORTS, 'createdAt');
    return c.json(await service.list(adminCtxOf(c), query));
  });

  app.post('/v1/providers', session, async (c) => {
    const body = createSchema.parse(await c.req.json());
    const row = await service.create(adminCtxOf(c), { adminId: c.get('adminId'), ...body });
    return c.json(row, 201);
  });

  app.patch('/v1/providers/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const patch = updateSchema.parse(await c.req.json());
    return c.json(await service.update(adminCtxOf(c), { adminId: c.get('adminId'), providerId: id, patch }));
  });

  app.delete('/v1/providers/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    return c.json(await service.retire(adminCtxOf(c), { adminId: c.get('adminId'), providerId: id }));
  });

  return app;
}
