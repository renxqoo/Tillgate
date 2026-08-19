/**
 * 兑换码路由（会话）：POST /v1/redeem（频率闸在 service）+ GET /v1/redeem/history。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { RedeemService } from '../services/redeem.service.js';

const redeemSchema = z.object({ code: z.string().trim().min(1).max(128) });

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function redeemRoutes(service: RedeemService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.post('/v1/redeem', session, async (c) => {
    const body = redeemSchema.parse(await c.req.json());
    const result = await service.redeem(userCtxOf(c), c.get('userId'), body);
    return c.json(result);
  });

  app.get('/v1/redeem/history', session, async (c) => {
    const query = historyQuerySchema.parse(c.req.query());
    const rows = await service.history(userCtxOf(c), c.get('userId'), query);
    return c.json({ rows });
  });

  return app;
}
