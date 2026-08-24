/**
 * 运营系统设置路由（system_configs KV 面）：计费时区读写（schedule 分时段策略）。
 * 全系统统一一个计费时区；写入留审计（settings.billing_timezone——control-plane）。
 */
import { Hono } from 'hono';
import type { ControlPlane } from '@tillgate/control-plane';
import type { SessionEnv } from '../middleware/session';
import { controlContextOf } from '../middleware/session';
import { settingsContracts } from '../contracts/settings';

export interface SettingsRoutesDeps {
  readonly controlPlane: Pick<ControlPlane, 'settings'>;
}

export function settingsRoutes(deps: SettingsRoutesDeps) {
  const app = new Hono<SessionEnv>();
  const billingTimezone = deps.controlPlane.settings.billingTimezone;

  app.get('/v1/settings/billing-timezone', async (c) => c.json(await billingTimezone.read()));

  app.put('/v1/settings/billing-timezone', async (c) => {
    const body = settingsContracts.billingTimezoneUpdate.parse(await c.req.json());
    return c.json(
      await billingTimezone.update({ ctx: controlContextOf(c), timezone: body.timezone }),
    );
  });

  return app;
}
