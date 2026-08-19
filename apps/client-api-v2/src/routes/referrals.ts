/**
 * 邀请返利路由：GET /v1/referrals —— 我的邀请码/链接、已邀名单、累计佣金。
 * 奖励入账在注册链路、佣金在 worker 日结，本路由只读。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { ReferralService } from '../services/referral.service.js';

export function referralRoutes(
  service: ReferralService,
  session: MiddlewareHandler<SessionEnv>,
) {
  const app = new Hono<SessionEnv>();
  app.get('/v1/referrals', session, async (c) => {
    const data = await service.overview(userCtxOf(c), c.get('userId'));
    return c.json(data);
  });
  return app;
}
