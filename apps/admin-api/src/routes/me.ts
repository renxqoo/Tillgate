/**
 * 管理员自身路由（会话）：资料 / 改密（推进失效线 + 同拍新 token）/ 2FA 开关。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { adminCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { AdminAuthService } from '../services/auth.service.js';

const passwordSchema = z.object({
  oldPassword: z.string().min(1).max(256),
  newPassword: z.string().min(10).max(128),
});

const twoFactorSchema = z.object({ enabled: z.boolean() });

export function meRoutes(service: AdminAuthService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/me', session, async (c) => {
    const me = await service.me(adminCtxOf(c), c.get('adminId'));
    return c.json(me);
  });

  app.post('/v1/me/password', session, async (c) => {
    const body = passwordSchema.parse(await c.req.json());
    const result = await service.changePassword(adminCtxOf(c), {
      adminId: c.get('adminId'),
      oldPassword: body.oldPassword,
      newPassword: body.newPassword,
    });
    return c.json(result);
  });

  app.post('/v1/me/two-factor', session, async (c) => {
    const body = twoFactorSchema.parse(await c.req.json());
    const result = await service.setTwoFactorEnabled(adminCtxOf(c), {
      adminId: c.get('adminId'),
      enabled: body.enabled,
    });
    return c.json(result);
  });

  return app;
}
