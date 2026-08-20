/**
 * 营销配置路由：GET/PUT /v1/marketing/settings（拉新资金参数——2026-08-21
 * 从 env 迁入 DB，管理面唯一修改入口；改值即时生效、全程审计、历史不重算）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { SessionEnv } from '../middleware/session.js';
import { adminCtxOf } from './ctx.js';
import type { MarketingService } from '../services/marketing.service.js';

const amount = z.string().regex(/^\d{1,10}(\.\d{1,18})?$/, '金额为非负数字符串（≤18 位小数）');
const rate = z.string().regex(/^(?:0(?:\.\d{1,18})?|1(?:\.0{1,18})?)$/, '比例为 0–1（≤18 位小数）');

const putSchema = z.object({
  signupGiftAmount: amount,
  referralSignupBonus: amount,
  referralCommissionRate: rate,
});

export function marketingRoutes(service: MarketingService, session: MiddlewareHandler<SessionEnv>): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.get('/v1/marketing/settings', session, async (c) => {
    return c.json(await service.getSettings(adminCtxOf(c)));
  });

  app.put('/v1/marketing/settings', session, async (c) => {
    const body = putSchema.parse(await c.req.json().catch(() => null));
    return c.json(await service.updateSettings(adminCtxOf(c), { adminId: c.get('adminId'), ...body }));
  });

  return app;
}
