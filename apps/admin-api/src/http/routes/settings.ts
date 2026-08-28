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

// eslint-disable-next-line max-lines-per-function -- 设置面路由表平铺:时区+集成+地板（一文件一族,拆分制造人工接缝）
export function settingsRoutes(deps: SettingsRoutesDeps) {
  const app = new Hono<SessionEnv>();
  const {
    billingTimezone,
    debitFloorDefault,
    billingReservation,
    billingReservationLimit,
    platformCurrency,
    integrations,
  } = deps.controlPlane.settings;

  app.get('/v1/settings/billing-timezone', async (c) => c.json(await billingTimezone.read()));

  app.put('/v1/settings/billing-timezone', async (c) => {
    const body = settingsContracts.billingTimezoneUpdate.parse(await c.req.json());
    return c.json(
      await billingTimezone.update({ ctx: controlContextOf(c), timezone: body.timezone }),
    );
  });

  app.get('/v1/settings/integrations', async (c) => c.json(await integrations.list()));

  app.get('/v1/settings/debit-floor-default', async (c) =>
    c.json(await debitFloorDefault.read()),
  );

  app.put(
    '/v1/settings/debit-floor-default',
    jsonBody(settingsContracts.debitFloorDefaultUpdate),
    async (c) => {
      const body = c.req.valid('json');
      // 审计在 control-plane 用例内（settings.debit_floor_default；与 billing_timezone 同族）
      return c.json(await debitFloorDefault.update({ ctx: controlContextOf(c), floor: body.floor }));
    },
  );

  app.get('/v1/settings/billing-reservation', async (c) =>
    c.json(await billingReservation.read()),
  );

  app.get('/v1/settings/platform-currency', async (c) =>
    c.json(await platformCurrency.read()),
  );

  app.put(
    '/v1/settings/platform-currency',
    jsonBody(settingsContracts.platformCurrencyUpdate),
    async (c) => {
      const body = c.req.valid('json');
      // 写一次守卫（处女系统）在 control-plane 用例内；非处女 409 platform_currency_locked
      return c.json(
        await platformCurrency.update({ ctx: controlContextOf(c), currency: body.currency }),
      );
    },
  );

  app.get('/v1/settings/billing-reservation-limit', async (c) =>
    c.json(await billingReservationLimit.read()),
  );

  app.put(
    '/v1/settings/billing-reservation-limit',
    jsonBody(settingsContracts.billingReservationLimitUpdate),
    async (c) => {
      const body = c.req.valid('json');
      // 审计在 control-plane 用例内（settings.billing_reservation_limit；网关 TTL 内拾取）
      return c.json(await billingReservationLimit.update({ ctx: controlContextOf(c), limit: body.limit }));
    },
  );

  app.put(
    '/v1/settings/billing-reservation',
    jsonBody(settingsContracts.billingReservationUpdate),
    async (c) => {
      const body = c.req.valid('json');
      // 审计在 control-plane 用例内（settings.billing_reservation；网关 TTL 缓存内拾取）
      return c.json(await billingReservation.update({ ctx: controlContextOf(c), policy: body }));
    },
  );

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
