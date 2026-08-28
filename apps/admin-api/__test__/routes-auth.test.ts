/**
 * 契约测试：管理员登录面 wire 形状与编排语义（爆破双闸/防枚举 401/2FA 两步/
 * 守卫 fail-closed/状态闸/登出吊销）+ me 三动词（资料/改密同拍新 token/2FA 前置）。
 * authRoutes/meRoutes 独立装配（会话件用同一 sessionMiddleware——登录组公开例外）。
 * 机制语义本体在 identity/runtime 测试;此处锁 app 编排与 wire。
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '@tillgate/http';
import { identityErrors } from '@tillgate/identity';
import type { SessionEnv } from '../src/http/middleware/session';
import { createAclMiddleware } from '../src/http/middleware/acl';
import { ADMIN_FACE_OVERRIDES, adminErrorCatalog } from '../src/http/error-face';
import { mfaStub } from './helpers';
import { authRoutes, type AuthGuard, type AuthRoutesDeps } from '../src/http/routes/auth';
import { meRoutes, type MeRoutesDeps } from '../src/http/routes/me';

/** 错误面挂具:createAdminApp 的 errorHandler 同装配（独立路由测试复用同一目录渲染） */
function withErrorFace(routes: Hono<SessionEnv>): Hono<SessionEnv> {
  // ACL 时代:会话注入在全局中间件——独立挂具包一层新 app 先挂 session 再挂路由
  // (Hono 中间件须先于路由注册;令牌 'tok' → 超管授权面)
  const app = new Hono<SessionEnv>();
  // 生产形态复刻:全局 ACL 中间件(公开白名单内置;令牌 'tok' → 超管授权面直通)
  app.use(
    '*',
    createAclMiddleware(
      {
        validate: async (token: string) =>
          token === 'tok'
            ? {
                realm: 'admin',
                sub: String(ADMIN_ID),
                jti: 'j',
                iss: 'i',
                exp: 9,
                iat: 1,
              }
            : null,
        owner: async () => ({ status: 0, grants: { isSuper: true, codes: [] } }),
      },
      // 挂具全绑定形态(isSuper 直通;具体绑定判定由专测覆盖)
      async (method, path) => ({ method, path, code: 'users:read' }),
    ),
  );
  app.route('/', routes);
  app.onError((error, c) =>
    errorHandler({ catalog: adminErrorCatalog, overrides: ADMIN_FACE_OVERRIDES })(error, c),
  );
  return app;
}

const json = { 'content-type': 'application/json' };
const VALID_TOKEN = 'tok';
const ADMIN_ID = 7;

/** reset-password 挂具的挑战族动词显式失败替身(本端点不可达) */
const challengeNotUsed = async (): Promise<never> => {
  throw new Error('unused');
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
  email: 'ops@tillgate.dev',
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
  const audit = vi.fn(async () => {});
  const touch = vi.fn(async () => {});
  const sign = vi.fn(async () => 'signed-token');
  const deps: AuthRoutesDeps = {
    identity: {
      mfa: mfaStub(),
      passwords: {
        authenticate: async () => ({ userId: ADMIN_ID }),
        change: async () => ({ invalidBefore: '2026-08-23T00:00:00Z' }),
        reset: async () => ({ invalidBefore: '2026-08-23T00:00:00Z' }),
        exists: async () => [],
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
    mailerConfigured: () => false,
    invites: overrides?.invites ?? { consume: async () => null },
    sessionTtlSec: 3600,
    ...overrides,
  };
  return { app: withErrorFace(authRoutes(deps)), deps, emailIp, ip, audit, touch, sign };
}

describe('auth（P2 登录面）', () => {
  it('登录成功:无 2FA 直签 token;守卫清零 + touchLastLogin + success 审计', async () => {
    const { app, audit, touch, sign } = authHarness();
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tillgate.dev', password: 'correct horse' }),
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
          exists: async () => [],
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
      body: JSON.stringify({ email: 'ops@tillgate.dev', password: 'wrong' }),
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
      recordFailure: async () => {},
      recordSuccess: async () => {},
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
          exists: async () => [],
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
      body: JSON.stringify({ email: 'ops@tillgate.dev', password: 'wrong' }),
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'admin.login_locked' } });

    const broken: AuthGuard = {
      isLocked: async () => {
        throw new Error('redis down');
      },
      recordFailure: async () => {},
      recordSuccess: async () => {},
    };
    const { app: app2 } = authHarness({ guards: { emailIp: broken, ip: neverLockedGuard() } });
    const res2 = await app2.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tillgate.dev', password: 'x' }),
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
        touchLastLogin: async () => {},
      },
    });
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tillgate.dev', password: 'correct horse' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'admin.two_factor_unavailable' } });

    const { app: app2, audit } = authHarness({
      mailerConfigured: () => true,
      identity: {
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => ({ userId: ADMIN_ID }),
          change: async () => ({ invalidBefore: '' }),
          reset: async () => ({ invalidBefore: '' }),
          exists: async () => [],
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
        touchLastLogin: async () => {},
      },
    });
    const res2 = await app2.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tillgate.dev', password: 'correct horse' }),
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
          exists: async () => [],
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
        touchLastLogin: async () => {},
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
        challenges: {
          begin: (async () => {
            throw identityErrors.business('undeliverable_challenge', {
              kind: 'admin_two_factor_code',
            });
          }) as never,
          verify: (async () => ({ target: {}, payload: {} })) as never,
          abort: async () => ({ aborted: true }),
        },
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => ({ userId: ADMIN_ID }),
          change: async () => ({ invalidBefore: '2026-08-23T00:00:00Z' }),
          reset: async () => ({ invalidBefore: '2026-08-23T00:00:00Z' }),
          exists: async () => [],
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
      twoFactorAudit: async () => {},
      trustedProxyHops: 0,
      admins: {
        find: async () => adminRecord,
        setTwoFactorEnabled: async () => {},
      },
      sessionTtlSec: 3600,
      ...overrides,
    };
    return withErrorFace(meRoutes(deps));
  }

  it('GET me 资料;改密走 identity.change(admin realm)同拍新 token;2FA 前置 SMTP', async () => {
    const app = meHarness();
    const me = await app.request('/v1/me', { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      id: ADMIN_ID,
      email: 'ops@tillgate.dev',
      twoFactorEnabled: false,
    });

    const change = vi.fn(async () => ({ invalidBefore: '2026-08-23T00:00:00Z' }));
    const app2 = meHarness({
      identity: {
        challenges: {} as never,
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => ({ userId: 0 }),
          change,
          reset: async () => ({ invalidBefore: '' }),
          exists: async () => [],
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

    // admin-email-2fa：SMTP 前置前移到发码步——开关本体不再查 mailerConfigured
    const code = await app.request('/v1/me/two-factor/code', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(code.status).toBe(503);
    expect(await code.json()).toMatchObject({
      error: { code: 'identity.undeliverable_challenge' },
    });
  });
});

describe('POST /v1/auth/reset-password（邀请令牌消费,公开端点）', () => {
  /** 独立挂具:invite 令牌 + 可断言的 passwords.reset/exists;find 默认活跃资料行 */
  function resetHarness(over?: {
    find?: () => Promise<typeof adminRecord | null>;
    exists?: (userIds: number[]) => number[];
    reset?: () => Promise<{ invalidBefore: string }>;
  }) {
    const invites = {
      tokens: new Map<string, number>(),
      async issue(adminId: number) {
        // ≥20 字符(契约 min 口径);长度不足会被 zod 先拦,测不到消费链
        const token = `invite-${String(adminId).padStart(8, '0')}-${'t'.repeat(30)}-${invites.tokens.size + 1}`;
        invites.tokens.set(token, adminId);
        return token;
      },
      async consume(token: string) {
        const adminId = invites.tokens.get(token) ?? null;
        invites.tokens.delete(token);
        return adminId;
      },
      async tryStartCooldown() {
        return true;
      },
    };
    const reset = over?.reset ?? vi.fn(async () => ({ invalidBefore: '2026-08-23T00:00:00Z' }));
    const resetSpy = vi.fn(reset);
    const exists = vi.fn(async (input: { userIds: number[] }) =>
      (over?.exists ?? (() => []))(input.userIds),
    );
    const deps: AuthRoutesDeps = {
      identity: {
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => ({ userId: ADMIN_ID }),
          change: async () => ({ invalidBefore: '' }),
          reset: resetSpy as never,
          exists: exists as never,
        },
        challenges: { begin: challengeNotUsed, verify: challengeNotUsed, abort: challengeNotUsed },
        sessions: {
          sign: async () => 'signed-token',
          verify: async () => {
            throw new Error('unused');
          },
          validate: async () => null,
          logout: async () => ({ ok: true as const }),
        },
      },
      admins: {
        findByEmail: async () => adminRecord,
        find: over?.find ?? (async () => adminRecord),
        touchLastLogin: async () => {},
      },
      guards: { emailIp: neverLockedGuard(), ip: neverLockedGuard() },
      loginAudit: async () => {},
      trustedProxyHops: 0,
      mailerConfigured: () => true,
      invites,
      sessionTtlSec: 3600,
    };
    return { app: withErrorFace(authRoutes(deps)), invites, resetSpy, exists };
  }
  const post = (app: Hono<SessionEnv>, body: unknown) =>
    app.request('/v1/auth/reset-password', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(body),
    });

  it('成功:一次性消费 → passwords.reset(realm admin) → {ok:true};不自动登录', async () => {
    const h = resetHarness();
    const token = await h.invites.issue(ADMIN_ID);
    const res = await post(h.app, { token, password: 'new-password-123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.resetSpy).toHaveBeenCalledWith({
      userId: ADMIN_ID,
      realm: 'admin',
      newPassword: 'new-password-123',
    });
    // 令牌已消费(GETDEL 语义)
    expect(h.invites.tokens.has(token)).toBe(false);
  });

  it('重放/未知令牌统一 400 admin_reset_token_invalid(不泄漏原因)', async () => {
    const h = resetHarness();
    const token = await h.invites.issue(ADMIN_ID);
    expect((await post(h.app, { token, password: 'new-password-123' })).status).toBe(200);
    const replay = await post(h.app, { token, password: 'new-password-456' });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe(
      'admin.admin_reset_token_invalid',
    );
    const unknown = await post(h.app, { token: 'x'.repeat(43), password: 'new-password-456' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      'admin.admin_reset_token_invalid',
    );
    expect(h.resetSpy).toHaveBeenCalledTimes(1);
  });

  it('安全回归:对方已设密码后旧邀请链接作废(泄露链接改不了已激活账号的密码)', async () => {
    const h = resetHarness({ exists: () => [ADMIN_ID] });
    const token = await h.invites.issue(ADMIN_ID);
    const res = await post(h.app, { token, password: 'hijack-password-9' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'admin.admin_reset_token_invalid',
    );
    expect(h.resetSpy).not.toHaveBeenCalled();
  });

  it('封禁/资料行缺失同口径 400(封禁者不可经邀请激活)', async () => {
    const banned = resetHarness({ find: async () => ({ ...adminRecord, status: 1 }) });
    const t1 = await banned.invites.issue(ADMIN_ID);
    expect((await post(banned.app, { token: t1, password: 'new-password-123' })).status).toBe(400);

    const missing = resetHarness({ find: async () => null });
    const t2 = await missing.invites.issue(ADMIN_ID);
    const res = await post(missing.app, { token: t2, password: 'new-password-123' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'admin.admin_reset_token_invalid',
    );
    expect(banned.resetSpy).not.toHaveBeenCalled();
    expect(missing.resetSpy).not.toHaveBeenCalled();
  });

  it('弱口令透传 identity.weak_password(策略单源);参数矩阵:token 过短/超长 400', async () => {
    const h = resetHarness({
      reset: async () => {
        throw identityErrors.business('weak_password', { minLength: 8 });
      },
    });
    const token = await h.invites.issue(ADMIN_ID);
    const weak = await post(h.app, { token, password: 'short' });
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { error: { code: string } }).error.code).toBe(
      'identity.weak_password',
    );

    expect(
      (await post(h.app, { token: 'x'.repeat(19), password: 'new-password-123' })).status,
    ).toBe(400);
    expect(
      (await post(h.app, { token: 'x'.repeat(129), password: 'new-password-123' })).status,
    ).toBe(400);
    expect((await post(h.app, { token, password: '' })).status).toBe(400);
  });
});
