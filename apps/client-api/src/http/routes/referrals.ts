/**
 * 邀请返利路由（会话，只读）：GET /v1/referrals/config 与 GET /v1/referrals。
 * 奖励入账在注册链路、佣金在 worker 日结；佣金累计和 = billing 佣金腿求和（app-face join）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AccountUseCases } from '@tillgate/accounts';
import { referralConfigView, referralOverviewRow } from '../presenters/referrals.js';
import type { SessionEnv } from '../middleware/session.js';

export interface ReferralsDeps {
  readonly marketingSettings: AccountUseCases['getMarketingSettings'];
  readonly overview: AccountUseCases['referralOverview'];
  /** 佣金累计（billing 钱包 refType=referral 佣金腿求和；billing-read 适配器） */
  readonly totalCommission: (userId: number) => Promise<string>;
  readonly frontendBaseUrl: string;
}

export function referralRoutes(deps: ReferralsDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/referrals/config', session, async (c) => {
    return c.json(referralConfigView(await deps.marketingSettings()));
  });

  app.get('/v1/referrals', session, async (c) => {
    const [overview, totalCommission] = await Promise.all([
      deps.overview({ userId: c.get('userId'), frontendBaseUrl: deps.frontendBaseUrl }),
      deps.totalCommission(c.get('userId')),
    ]);
    return c.json(referralOverviewRow(overview, totalCommission));
  });

  return app;
}
