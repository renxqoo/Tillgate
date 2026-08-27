/**
 * 敏感确认面规格：
 * - 集成写入（PUT /v1/settings/integrations/:key）仍走 TOTP step-up：
 *   未绑定 403（totp_stepup_required 引导绑定）；错码 401（invalid_totp_code）
 *   + IP 守卫计数 + 失败审计；对码放行；6 位数字契约校验先于一切。
 * - 2FA 邮箱开关走「邮箱码自证」（admin-email-2fa）：先
 *   POST /v1/me/two-factor/code 发码（SMTP fail-closed 前移到发码步），再验码
 *   开关（expect 主体绑定）；取消 TOTP 前置与 step-up。
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
const sessionPayload = {
  sub: '1',
  realm: 'admin',
  jti: 'j1',
  iss: 'i',
  iat: 1,
  exp: 9_999_999_999,
};

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
const twoFactorAuditProbe = vi.fn(async () => {});

function appHarness(opts?: {
  stepupError?: Error;
  updateImpl?: () => Promise<unknown>;
  setTwoFactorImpl?: () => Promise<void>;
  beginImpl?: () => Promise<unknown>;
  verifyImpl?: () => Promise<unknown>;
  enabledFrom?: boolean;
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
        challenges: {
          begin: (opts?.beginImpl ??
            (async () => ({ challengeId: '11111111-1111-4111-8111-111111111111' }))) as never,
          verify: (opts?.verifyImpl ?? (async () => ({ target: {}, payload: {} }))) as never,
        },
        mfa: mfaStub({ stepupError: opts?.stepupError }),
        passwords: {} as never,
        sessions: {} as never,
      } as never,
      twoFactorAudit: twoFactorAuditProbe,
      admins: {
        find: async () => ({ status: 0, twoFactorEnabled: opts?.enabledFrom ?? false }) as never,
        setTwoFactorEnabled: opts?.setTwoFactorImpl ?? (async () => {}),
      } as never,
      rbac: {} as never,
      trustedProxyHops: 0,
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

describe('step-up 强制点（ADR-0011——集成写入不受 2FA 改造影响）', () => {
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

  it('对码放行 → update 落库', async () => {
    const { app } = appHarness();
    const put = await app.request('/v1/settings/integrations/smtp', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ totpCode: '123456', enabled: false }),
    });
    expect(put.status).toBe(200);
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

describe('2FA 邮箱码自证（admin-email-2fa，DESIGN §2）', () => {
  it('发码：kind=admin_two_factor_code、目标=本人、purpose 区分文案', async () => {
    const begin = vi.fn(async () => ({ challengeId: 'ch-9' }));
    const { app } = appHarness({ beginImpl: begin as never });
    const res = await app.request('/v1/me/two-factor/code', { method: 'POST', headers: json });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challengeId: 'ch-9' });
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'admin_two_factor_code',
        target: { userId: ADMIN_ID },
        delivery: expect.objectContaining({ purpose: 'two_factor_toggle' }),
      }),
    );
  });

  it('发码：SMTP 未生效 → 503 undeliverable（通道校验前移到发码步，fail-closed）', async () => {
    const { app } = appHarness({
      beginImpl: (async () => {
        throw identityErrors.business('undeliverable_challenge', { kind: 'admin_two_factor_code' });
      }) as never,
    });
    const res = await app.request('/v1/me/two-factor/code', { method: 'POST', headers: json });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'identity.undeliverable_challenge' } });
  });

  it('发码：60s 冷却 → 429 challenge_cooldown', async () => {
    const { app } = appHarness({
      beginImpl: (async () => {
        throw identityErrors.business('challenge_cooldown', { retryAfterMs: 42_000 });
      }) as never,
    });
    const res = await app.request('/v1/me/two-factor/code', { method: 'POST', headers: json });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'identity.challenge_cooldown' } });
  });

  it('开关：验码成功 → 落库 + 成功审计（enabledFrom/To），无需 TOTP', async () => {
    const setTwoFactor = vi.fn(async () => {});
    const { app } = appHarness({ setTwoFactorImpl: setTwoFactor, enabledFrom: false });
    const res = await app.request('/v1/me/two-factor', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        enabled: true,
        challengeId: '11111111-1111-4111-8111-111111111111',
        code: '123456',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ twoFactorEnabled: true });
    expect(setTwoFactor).toHaveBeenCalledWith({ adminId: ADMIN_ID, enabled: true });
    expect(twoFactorAuditProbe).toHaveBeenCalledWith({
      adminId: ADMIN_ID,
      enabledFrom: false,
      enabledTo: true,
    });
  });

  it('开关：错码 → 400 code_invalid，不触达 setTwoFactorEnabled 与审计', async () => {
    const setTwoFactor = vi.fn(async () => {});
    const { app } = appHarness({
      setTwoFactorImpl: setTwoFactor,
      verifyImpl: (async () => {
        throw identityErrors.business('code_invalid', { remainingAttempts: 3 });
      }) as never,
    });
    const res = await app.request('/v1/me/two-factor', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        enabled: true,
        challengeId: '11111111-1111-4111-8111-111111111111',
        code: '000000',
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'identity.code_invalid' } });
    expect(setTwoFactor).not.toHaveBeenCalled();
    expect(twoFactorAuditProbe).not.toHaveBeenCalled();
  });

  it('开关：挑战无效（过期/耗尽/已消费/跨主体 expect 不符）→ 400 challenge_invalid', async () => {
    const { app } = appHarness({
      verifyImpl: (async () => {
        throw identityErrors.business('challenge_invalid', {});
      }) as never,
    });
    const res = await app.request('/v1/me/two-factor', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        enabled: false,
        challengeId: '11111111-1111-4111-8111-111111111111',
        code: '123456',
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'identity.challenge_invalid' } });
  });

  it('契约换代（单轨）：旧体 totpCode 拒；新体要求 uuid + 6 位码 + enabled', async () => {
    const { app } = appHarness();
    const legacy = await app.request('/v1/me/two-factor', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ totpCode: '123456', enabled: true }),
    });
    expect(legacy.status).toBe(400);
    const badShape = await app.request('/v1/me/two-factor', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ enabled: true, challengeId: 'not-uuid', code: '12345' }),
    });
    expect(badShape.status).toBe(400);
  });
});
