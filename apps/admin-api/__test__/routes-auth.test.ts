/**
 * P2 契约测试：管理员登录面 wire 形状与编排语义（爆破双闸/防枚举 401/2FA 两步/
 * 守卫 fail-closed/状态闸/登出吊销）+ me 三动词（资料/改密同拍新 token/2FA 前置）。
 * authRoutes/meRoutes 独立装配（会话件用同一 sessionMiddleware——登录组公开例外）。
 * 机制语义本体在 identity/runtime 测试;此处锁 app 编排与 wire。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Hono, MiddlewareHandler } from 'hono';
import { errorHandler } from '@tokenlens/http';
import { identityErrors } from '@tokenlens/identity';
import type { SessionEnv } from '../src/http/middleware/session';
import { ADMIN_FACE_OVERRIDES, adminErrorCatalog } from '../src/http/error-face';
import { mfaStub } from './helpers';
import { authRoutes, type AuthGuard, type AuthRoutesDeps } from '../src/http/routes/auth';
import { meRoutes, type MeRoutesDeps } from '../src/http/routes/me';

/** 错误面挂具:createAdminApp 的 errorHandler 同装配（独立路由测试复用同一目录渲染） */
function withErrorFace(app: Hono<SessionEnv>): Hono<SessionEnv> {
  app.onError((error, c) =>
    errorHandler({ catalog: adminErrorCatalog, overrides: ADMIN_FACE_OVERRIDES })(error, c),
  );
  return app;
}

const json = { 'content-type': 'application/json' };
const VALID_TOKEN = 'tok';
const ADMIN_ID = 7;

/** 会话件替身:固定 token → adminId=7（属主回查路径在 session.test 覆盖） */
const session: MiddlewareHandler<SessionEnv> = async (c, next) => {
  if (c.req.header('authorization') !== `Bearer ${VALID_TOKEN}`) {
    return c.json({ error: { code: 'http.unauthorized' } }, 401);
  }
  c.set('requestId', 'req-test');
  c.set('adminId', ADMIN_ID);
  c.set('sessionToken', VALID_TOKEN);
  c.set('sessionJti', 'jti-1');
  c.set('sessionExp', Math.floor(Date.now() / 1000) + 60);
  await next();
};

function neverLockedGuard(): AuthGuard & { failures: number; successes: number } {
  let failures = 0;
  let successes = 0;
  return {
    get failures() {
      return failures;
    },
    get successes() {
      return successes;
    },
    isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
    recordFailure: async () => {
      failures += 1;
    },
    recordSuccess: async () => {
      successes += 1;
    },
  };
}

const adminRecord = {
  id: ADMIN_ID,
  email: 'ops@tokenlens.dev',
  displayName: 'Ops',
  status: 0,
  roleId: 1,
  role: 'super_admin',
  twoFactorEnabled: false,
  lastLoginAt: null,
  createdAt: new Date(0),
};

function authHarness(overrides?: Partial<AuthRoutesDeps>) {
  const emailIp = neverLockedGuard();
  const ip = neverLockedGuard();
  const audit = vi.fn(async () => undefined);
  const touch = vi.fn(async () => undefined);
  const sign = vi.fn(async () => 'signed-token');
  const deps: AuthRoutesDeps = {
    identity: {
      mfa: mfaStub(),
      passwords: {
        authenticate: async () => ({ userId: ADMIN_ID }),
        change: async () => ({ invalidBefore: '2026-08-23T00:00:00Z' }),
        reset: async () => ({ invalidBefore: '2026-08-23T00:00:00Z' }),
      },
      challenges: {
        begin: (async () => ({ challengeId: 'ch-1' })) as never,
        verify: (async () => ({ payload: { adminId: ADMIN_ID } })) as never,
        abort: async () => ({ aborted: true }),
      },
      sessions: {
        sign,
        verify: async () => {
          throw new Error('unused');
        },
        validate: async () => null,
        logout: async () => ({ ok: true as const }),
      },
    },
    admins: {
      findByEmail: async () => adminRecord,
      find: async () => adminRecord,
      touchLastLogin: touch,
    },
    guards: { emailIp, ip },
    loginAudit: audit,
    trustedProxyHops: 0,
    mailerConfigured: false,
    sessionTtlSec: 3600,
    ...overrides,
  };
  return { app: withErrorFace(authRoutes(deps, session)), deps, emailIp, ip, audit, touch, sign };
}

describe('auth（P2 登录面）', () => {
  it('登录成功:无 2FA 直签 token;守卫清零 + touchLastLogin + success 审计', async () => {
    const { app, audit, touch, sign } = authHarness();
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tokenlens.dev', password: 'correct horse' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'signed-token', adminId: ADMIN_ID });
    expect(sign).toHaveBeenCalledWith({ realm: 'admin', subjectId: ADMIN_ID, ttlSec: 3600 });
    expect(touch).toHaveBeenCalledWith(ADMIN_ID);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login.success', adminId: ADMIN_ID }),
    );
  });

  it('凭据错:双闸计数 + invalid_credentials 审计 + identity.invalid_credentials 401 原样透传', async () => {
    const { app, emailIp, ip, audit } = authHarness({
      identity: {
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => {
            throw identityErrors.business('invalid_credentials', { realm: 'admin' });
          },
          change: async () => ({ invalidBefore: '' }),
          reset: async () => ({ invalidBefore: '' }),
        },
        challenges: {
          begin: (async () => ({ challengeId: '' })) as never,
          verify: (async () => ({ payload: {} })) as never,
          abort: async () => ({ aborted: true }),
        },
        sessions: {
          sign: async () => '',
          verify: async () => {
            throw new Error('x');
          },
          validate: async () => null,
          logout: async () => ({ ok: true as const }),
        },
      },
    });
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tokenlens.dev', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'identity.invalid_credentials' } });
    expect(emailIp.failures).toBe(1);
    expect(ip.failures).toBe(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login.invalid_credentials', adminId: null }),
    );
  });

  it('已锁定:同键计数路径 429 admin.login_locked;守卫抛错 503 auth_guard_unavailable', async () => {
    const locked: AuthGuard = {
      isLocked: async () => ({ locked: true, retryAfterSec: 600 }),
      recordFailure: async () => undefined,
      recordSuccess: async () => undefined,
    };
    const { app } = authHarness({
      guards: { emailIp: locked, ip: neverLockedGuard() },
      identity: {
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => {
            throw identityErrors.business('invalid_credentials', { realm: 'admin' });
          },
          change: async () => ({ invalidBefore: '' }),
          reset: async () => ({ invalidBefore: '' }),
        },
        challenges: {
          begin: (async () => ({ challengeId: '' })) as never,
          verify: (async () => ({ payload: {} })) as never,
          abort: async () => ({ aborted: true }),
        },
        sessions: {
          sign: async () => '',
          verify: async () => {
            throw new Error('x');
          },
          validate: async () => null,
          logout: async () => ({ ok: true as const }),
        },
      },
    });
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tokenlens.dev', password: 'wrong' }),
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'admin.login_locked' } });

    const broken: AuthGuard = {
      isLocked: async () => {
        throw new Error('redis down');
      },
      recordFailure: async () => undefined,
      recordSuccess: async () => undefined,
    };
    const { app: app2 } = authHarness({ guards: { emailIp: broken, ip: neverLockedGuard() } });
    const res2 = await app2.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tokenlens.dev', password: 'x' }),
    });
    expect(res2.status).toBe(503);
    expect(await res2.json()).toMatchObject({ error: { code: 'admin.auth_guard_unavailable' } });
  });

  it('2FA 开启:SMTP 未配置 503 fail-closed;已配置走两步（challenge + 审计 2fa）', async () => {
    const begin = vi.fn(async () => ({ challengeId: 'ch-9' }));
    const { app } = authHarness({
      admins: {
        findByEmail: async () => ({ ...adminRecord, twoFactorEnabled: true }),
        find: async () => adminRecord,
        touchLastLogin: async () => undefined,
      },
    });
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tokenlens.dev', password: 'correct horse' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'admin.two_factor_unavailable' } });

    const { app: app2, audit } = authHarness({
      mailerConfigured: true,
      identity: {
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => ({ userId: ADMIN_ID }),
          change: async () => ({ invalidBefore: '' }),
          reset: async () => ({ invalidBefore: '' }),
        },
        challenges: {
          begin: begin as unknown as AuthRoutesDeps['identity']['challenges']['begin'],
          verify: (async () => ({ payload: { adminId: ADMIN_ID } })) as never,
          abort: async () => ({ aborted: true }),
        },
        sessions: {
          sign: async () => 'signed-token',
          verify: async () => {
            throw new Error('x');
          },
          validate: async () => null,
          logout: async () => ({ ok: true as const }),
        },
      },
      admins: {
        findByEmail: async () => ({ ...adminRecord, twoFactorEnabled: true }),
        find: async () => adminRecord,
        touchLastLogin: async () => undefined,
      },
    });
    const res2 = await app2.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tokenlens.dev', password: 'correct horse' }),
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({
      twoFactorRequired: true,
      method: 'email',
      challengeId: 'ch-9',
    });
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({ kind: 'admin_login_code' }));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login.2fa_challenge' }),
    );
  });

  it('verify:payload adminId 状态复查后签发;封禁 403;logout 吊销原始 token', async () => {
    const logout = vi.fn(async () => ({ ok: true as const }));
    const { app } = authHarness({
      identity: {
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => ({ userId: ADMIN_ID }),
          change: async () => ({ invalidBefore: '' }),
          reset: async () => ({ invalidBefore: '' }),
        },
        challenges: {
          begin: (async () => ({ challengeId: '' })) as never,
          verify: (async () => ({ payload: { adminId: ADMIN_ID } })) as never,
          abort: async () => ({ aborted: true }),
        },
        sessions: {
          sign: async () => 'signed-token',
          verify: async () => {
            throw new Error('x');
          },
          validate: async () => null,
          logout,
        },
      },
    });
    const verified = await app.request('/v1/auth/login/verify', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ challengeId: '0b1a2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', code: '123456' }),
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ token: 'signed-token', adminId: ADMIN_ID });

    const banned = await authHarness({
      admins: {
        findByEmail: async () => adminRecord,
        find: async () => ({ ...adminRecord, status: 1 }),
        touchLastLogin: async () => undefined,
      },
    }).app.request('/v1/auth/login/verify', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ challengeId: '0b1a2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', code: '123456' }),
    });
    expect(banned.status).toBe(403);

    const out = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(out.status).toBe(200);
    expect(logout).toHaveBeenCalledWith(VALID_TOKEN, 'admin');
  });
});

describe('me（P2 管理员自身）', () => {
  function meHarness(overrides?: Partial<MeRoutesDeps>) {
    const deps: MeRoutesDeps = {
      rbac: {
        roles: {
          find: async () => ({
            id: 1,
            code: 'super_admin',
            name: '超级管理员',
            description: null,
            status: 0,
            isSuper: true,
            isBuiltin: true,
            createdAt: new Date(0),
          }),
        },
        permissions: {
          tree: async () => [],
          create: async () => {
            throw new Error('fake');
          },
          update: async () => {
            throw new Error('fake');
          },
          remove: async () => ({ ok: true as const }),
          activeCodes: async () => [],
        },
      },
      identity: {
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => ({ userId: ADMIN_ID }),
          change: async () => ({ invalidBefore: '2026-08-23T00:00:00Z' }),
          reset: async () => ({ invalidBefore: '2026-08-23T00:00:00Z' }),
        },
        sessions: {
          sign: async () => 'new-token',
          verify: async () => {
            throw new Error('x');
          },
          validate: async () => null,
          logout: async () => ({ ok: true as const }),
        },
      },
      admins: {
        find: async () => adminRecord,
        setTwoFactorEnabled: async () => undefined,
      },
      mailerConfigured: false,
      sessionTtlSec: 3600,
      ...overrides,
    };
    return withErrorFace(meRoutes(deps, session));
  }

  it('GET me 资料;改密走 identity.change(admin realm)同拍新 token;2FA 前置 SMTP', async () => {
    const app = meHarness();
    const me = await app.request('/v1/me', { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      id: ADMIN_ID,
      email: 'ops@tokenlens.dev',
      twoFactorEnabled: false,
    });

    const change = vi.fn(async () => ({ invalidBefore: '2026-08-23T00:00:00Z' }));
    const app2 = meHarness({
      identity: {
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => ({ userId: 0 }),
          change,
          reset: async () => ({ invalidBefore: '' }),
        },
        sessions: {
          sign: async () => 'new-token',
          verify: async () => {
            throw new Error('x');
          },
          validate: async () => null,
          logout: async () => ({ ok: true as const }),
        },
      },
    });
    const res = await app2.request('/v1/me/password', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${VALID_TOKEN}` },
      body: JSON.stringify({ oldPassword: 'old-pass', newPassword: 'new-pass-123' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'new-token' });
    expect(change).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      realm: 'admin',
      currentPassword: 'old-pass',
      newPassword: 'new-pass-123',
    });

    const enable = await app.request('/v1/me/two-factor', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${VALID_TOKEN}` },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enable.status).toBe(400);
    expect(await enable.json()).toMatchObject({ error: { code: 'admin.smtp_not_configured' } });
  });
});
