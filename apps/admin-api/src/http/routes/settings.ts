/**
 * 运营系统设置路由：计费时区（system_configs KV）与第三方集成动态配置
 * （integration_settings 表）。写入均留审计（control-plane）。
 */
import { Hono } from 'hono';
import { jsonBody } from '@tillgate/http';
import type { ControlPlane } from '@tillgate/control-plane';
import type { SessionEnv } from '../middleware/session';
import { controlContextOf } from '../middleware/session';
import { settingsContracts } from '../contracts/settings';
import { requireTotpStepup, type StepupVerifyDeps } from '../stepup-verify';

export interface SettingsRoutesDeps extends StepupVerifyDeps {
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

  app.put(
    '/v1/settings/integrations/:key',
    jsonBody(settingsContracts.integrationsUpdate),
    async (c) => {
      const body = c.req.valid('json');
      // step-up 强制点：配置/启停共用本端点，未验 TOTP 不得落库
      await requireTotpStepup(deps, c, body.totpCode);
      return c.json(
        await integrations.update({
          ctx: controlContextOf(c),
          key: c.req.param('key'),
          ...(body.enabled != null ? { enabled: body.enabled } : {}),
          ...(body.config != null ? { config: body.config } : {}),
        }),
      );
    },
  );

  // SMTP 连通性探针：只读不落库（连接+认证，不发送邮件）——与渠道测试端点同免 step-up；
  // 成功/失败都是探针结果（ok 字段），失败不抬 4xx/5xx
  app.post(
    '/v1/settings/integrations/smtp/test',
    jsonBody(settingsContracts.integrationsProbe),
    async (c) => {
      const body = c.req.valid('json');
      return c.json(
        await integrations.probeSmtp(body.config != null ? { config: body.config } : {}),
      );
    },
  );

  return app;
}
