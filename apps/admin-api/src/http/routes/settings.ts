/**
 * 运营系统设置路由：计费时区（system_configs KV）与第三方集成动态配置
 * （integration_settings——docs/integration-settings）。写入均留审计（control-plane）。
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
  const { billingTimezone, integrations } = deps.controlPlane.settings;

  app.get('/v1/settings/billing-timezone', async (c) => c.json(await billingTimezone.read()));

  app.put('/v1/settings/billing-timezone', async (c) => {
    const body = settingsContracts.billingTimezoneUpdate.parse(await c.req.json());
    return c.json(
      await billingTimezone.update({ ctx: controlContextOf(c), timezone: body.timezone }),
    );
  });

  app.get('/v1/settings/integrations', async (c) => c.json(await integrations.list()));

  app.put('/v1/settings/integrations/:key', async (c) => {
    const body = settingsContracts.integrationsUpdate.parse(await c.req.json());
    return c.json(
      await integrations.update({
        ctx: controlContextOf(c),
        key: c.req.param('key'),
        ...(body.enabled != null ? { enabled: body.enabled } : {}),
        ...(body.config != null ? { config: body.config } : {}),
      }),
    );
  });

  return app;
}
