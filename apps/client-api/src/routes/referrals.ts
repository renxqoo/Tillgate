import { Hono } from 'hono';
import type { ClientEnv } from '@ai-gateway/identity';
import { inviteOverview } from '../services/referrals.js';

/**
 * GET /api/referrals —— 邀请概览（我的邀请码/链接、已邀列表、累计佣金）。
 * 奖励与佣金入账在注册链路与 worker 日结，本路由只读。
 */
export function referralRoutes(
  overview: (userId: number) => ReturnType<typeof inviteOverview>,
): Hono<ClientEnv> {
  return new Hono<ClientEnv>().get('/', async (c) => {
    const data = await overview(c.var.session.userId);
    return c.json(data);
  });
}
