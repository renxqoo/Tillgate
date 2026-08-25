/**
 * TOTP step-up 强制点规格（ADR-0011）：集成写入（PUT /v1/settings/integrations/:key）
 * 与 2FA 邮箱开关（POST /v1/me/two-factor）共享 requireTotpStepup——
 * 未绑定 403（totp_stepup_required 引导绑定）；错码 401（invalid_totp_code）
 * + IP 守卫计数 + 失败审计；对码放行；6 位数字契约校验先于一切。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { errorHandler } from '@tillgate/http';
import { identityErrors } from '@tillgate/identity';
import { settingsRoutes } from '../src/http/routes/settings';
import { meRoutes } from '../src/http/routes/me';
import { adminErrorCatalog, ADMIN_FACE_OVERRIDES } from '../src/http/error-face';
import { mfaStub } from './helpers';
import { sessionMiddleware } from '../src/http/middleware/session';

const ADMIN_ID = 1;
const VALID_TOKEN = 'tok-stepup';
const sessionPayload = { sub: '1', realm: 'admin', jti: 'j1', iss: 'i', iat: 1, exp: 9_999_999_999 };

/** 守卫替身：可编程锁定 + 失败计数断言面 */
function guardProbe() {
  const failures = { ip: 0 };
  return {
    failures,
    deps: {
      isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
      recordFailure: async () => {
        failures.ip += 1;
        return { locked: false, retryAfterSec: 0 };
      },
    },
  };
}

const auditProbe = vi.fn(async () => {});

function appHarness(opts?: {
  stepupError?: Error;
  updateImpl?: () => Promise<unknown>;
  setTwoFactorImpl?: () => Promise<void>;
}) {
  const guard = guardProbe();
  const integrations = {
    list: async () => ({ integrations: [] }),
    update:
      opts?.updateImpl ??
      (async () => ({
        key: 'smtp',
        enabled: false,
        configured: true,
        config: {},
        secretsSet: [],
        rotatedAt: null,
        updatedAt: null,
        updatedByAdminId: null,
      })),
  };
  const app = new Hono();
  app.use(
    '*',
    sessionMiddleware({
      validate: async (token: string) => (token === VALID_TOKEN ? sessionPayload : null),
      owner: async () => ({ status: 0, grants: { isSuper: true, codes: [] } }),
    }) as MiddlewareHandler,
  );
  app.route(
    '/',
    settingsRoutes({
        controlPlane: { settings: { billingTimezone: {} as never, integrations } } as never,
        identity: { mfa: mfaStub({ stepupError: opts?.stepupError }) } as never,
        guards: { ip: guard.deps },
        audit: auditProbe as never,
        trustedProxyHops: 0,
      }),
  );
  app.route(
    '/',
    meRoutes({
        identity: {
          mfa: mfaStub({ stepupError: opts?.stepupError }),
          passwords: {} as never,
          sessions: {} as never,
        } as never,
        stepup: { guards: { ip: guard.deps }, audit: auditProbe as never, trustedProxyHops: 0 },
        admins: {
          find: async () => ({ status: 0 }) as never,
          setTwoFactorEnabled: opts?.setTwoFactorImpl ?? (async () => {}),
        } as never,
        rbac: {} as never,
        mailerConfigured: () => true,
        sessionTtlSec: 3_600,
      }),
  );
  app.onError((error, c) =>
    errorHandler({ catalog: adminErrorCatalog, overrides: ADMIN_FACE_OVERRIDES })(error, c),
  );
  return { app, guard };
}

const json = { 'content-type': 'application/json', authorization: `Bearer ${VALID_TOKEN}` };

afterEach(() => {
  vi.clearAllMocks();
});

describe('step-up 强制点（ADR-0011）', () => {
  it('未绑定验证器 → 403 totp_stepup_required（引导绑定），写入用例不被调用', async () => {
    const update = vi.fn();
    const { app } = appHarness({
      stepupError: identityErrors.business('totp_not_enrolled', { userId: ADMIN_ID }),
      updateImpl: update as never,
    });
    const res = await app.request('/v1/settings/integrations/smtp', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ totpCode: '123456', enabled: false }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'admin.totp_stepup_required' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('错码 → 400 invalid_totp_code（登录面同码同口径）+ IP 守卫计数 + 失败审计', async () => {
    const { app, guard } = appHarness({
      stepupError: identityErrors.business('invalid_totp_code', { userId: ADMIN_ID }),
    });
    const res = await app.request('/v1/settings/integrations/smtp', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ totpCode: '000000', enabled: false }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'admin.invalid_totp_code' } });
    expect(guard.failures.ip).toBe(1);
    expect(auditProbe).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'settings.stepup.failed', adminId: ADMIN_ID }),
    );
  });

  it('对码放行 → update 落库；2FA 开关同口径（错码拒绝不触达 setTwoFactorEnabled）', async () => {
    const { app } = appHarness();
    const put = await app.request('/v1/settings/integrations/smtp', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ totpCode: '123456', enabled: false }),
    });
    expect(put.status).toBe(200);

    const setTwoFactor = vi.fn(async () => {});
    const { app: app2 } = appHarness({
      stepupError: identityErrors.business('invalid_totp_code', { userId: ADMIN_ID }),
      setTwoFactorImpl: setTwoFactor,
    });
    const toggle = await app2.request('/v1/me/two-factor', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ totpCode: '000000', enabled: true }),
    });
    expect(toggle.status).toBe(400);
    expect(setTwoFactor).not.toHaveBeenCalled();
  });

  it('码形契约：缺码/非 6 位 → 400，先于 stepup 与业务用例', async () => {
    const { app } = appHarness();
    const missing = await app.request('/v1/settings/integrations/smtp', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ enabled: false }),
    });
    expect(missing.status).toBe(400);
    const bad = await app.request('/v1/settings/integrations/smtp', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ totpCode: '12345', enabled: false }),
    });
    expect(bad.status).toBe(400);
  });
});
