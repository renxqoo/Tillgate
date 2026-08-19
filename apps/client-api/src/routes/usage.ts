/**
 * 用量路由（会话）：明细（billedBy 拆分）/ 按模型聚合 / 实时速率。
 * 用户隔离在 repo 层硬绑定（userId 从会话取，不收请求参数）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { UsageService } from '../services/usage.service.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  model: z.string().max(64).optional(),
});

const rangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export function usageRoutes(service: UsageService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/usage', session, async (c) => {
    const query = listQuerySchema.parse(c.req.query());
    const result = await service.list(userCtxOf(c), c.get('userId'), query);
    return c.json({ rows: result.rows, total: result.total, page: query.page, limit: query.limit });
  });

  app.get('/v1/usage/by-model', session, async (c) => {
    const query = rangeQuerySchema.parse(c.req.query());
    const rows = await service.byModel(userCtxOf(c), c.get('userId'), query);
    return c.json({ rows });
  });

  app.get('/v1/usage/summary', session, async (c) => {
    const query = rangeQuerySchema.parse(c.req.query());
    const result = await service.summary(userCtxOf(c), c.get('userId'), query);
    return c.json(result);
  });

  app.get('/v1/usage/rate', session, async (c) => {
    const rate = await service.rate(userCtxOf(c), c.get('userId'));
    return c.json(rate);
  });

  return app;
}
