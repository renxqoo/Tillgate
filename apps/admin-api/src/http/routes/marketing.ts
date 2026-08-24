/**
 * 营销配置路由（P3;v1 routes/marketing.ts 平移）：GET/PUT /v1/marketing/settings。
 * 拉新资金参数存 DB（管理面唯一修改入口）;改值即时生效、历史不重算——
 * 审计在 accounts 用例内（actor=admin）;worker 佣金循环每 tick 读现值同源。
 */
import { Hono } from 'hono';
import type { AccountUseCases } from '@tillgate/accounts';
import type { SessionEnv } from '../middleware/session';
import { marketingContracts } from '../contracts/marketing';

export interface MarketingRoutesDeps {
  readonly accounts: Pick<AccountUseCases, 'getMarketingSettings' | 'updateMarketingSettings'>;
}

export function marketingRoutes(deps: MarketingRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/marketing/settings', async (c) =>
    c.json(await deps.accounts.getMarketingSettings()),
  );

  app.put('/v1/marketing/settings', async (c) => {
    const body = marketingContracts.updateSettings.parse(await c.req.json());
    return c.json(
      await deps.accounts.updateMarketingSettings({
        patch: body,
        adminId: c.get('adminId'),
      }),
    );
  });

  return app;
}
