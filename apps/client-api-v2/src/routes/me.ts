/**
 * 账户资料路由（会话）：GET /v1/me + PATCH /v1/me/display-name。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { AuthService } from '../services/auth.service.js';

const displayNameSchema = z.object({
  displayName: z.string().trim().min(1).max(64),
});

export function meRoutes(service: AuthService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/me', session, async (c) => {
    const result = await service.profile(userCtxOf(c), c.get('userId'));
    return c.json(result);
  });

  app.patch('/v1/me/display-name', session, async (c) => {
    const body = displayNameSchema.parse(await c.req.json());
    const result = await service.updateDisplayName(userCtxOf(c), c.get('userId'), body.displayName);
    return c.json(result);
  });

  return app;
}
