/**
 * TOTP 契约测试（绑定三动词 + 登录第二因子分流）:wire 形状与编排语义。
 * 机制语义（防重放/恢复码单次消费/挂起重挂换钥）在 identity 包测试;此处锁
 * app 编排:绑定即接管第二因子（不退回邮箱码）、码错计双闸、解绑须持有效码。
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '@tokenlens/http';
import { identityErrors } from '@tokenlens/identity';
import type { SessionEnv } from '../src/http/middleware/session';
import { createAclMiddleware } from '../src/http/middleware/acl';
import { ADMIN_FACE_OVERRIDES, adminErrorCatalog } from '../src/http/error-face';
import { authRoutes, type AuthGuard, type AuthRoutesDeps } from '../src/http/routes/auth';
import { meRoutes, type MeRoutesDeps } from '../src/http/routes/me';

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

function guard(): AuthGuard & { failures: number } {
  let failures = 0;
  return {
    get failures() {
      return failures;
    },
    isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
    recordFailure: async () => {
      failures += 1;
    },
    recordSuccess: async () => undefined,
  };
}

const adminRecord = {
  id: ADMIN_ID,
  email: 'ops@tokenlens.dev',
  displayName: 'Ops',
  status: 0,
  roleId: 1,
  role: 'super_admin',
  twoFactorEnabled: true, // 邮箱码开着也要被 TOTP 接管——防降级
  lastLoginAt: null,
  createdAt: new Date(0),
};

/** 可控 mfa 桩:confirmed 决定 status;verify 行为注入 */
function mfa(over: { confirmed: boolean; verifyError?: Error; disableResult?: boolean }) {
  return {
    status: async () => ({ enrolled: true, confirmed: over.confirmed }),
    enrollTotp: vi.fn(async () => ({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x' })),
    confirmTotp: vi.fn(async () => ({ recoveryCodes: ['RVWXYZ2345', 'WVXYZ23456'] })),
    verify: over.verifyError
      ? vi.fn(async () => {
          throw over.verifyError;
        })
      : vi.fn(async () => ({ method: 'totp' as const })),
    disableTotp: vi.fn(async () => ({ disabled: over.disableResult ?? true })),
  };
}

function baseIdentity(mfaImpl: ReturnType<typeof mfa>): AuthRoutesDeps['identity'] {
  return {
    mfa: mfaImpl,
    passwords: {
      authenticate: async () => ({ userId: ADMIN_ID }),
      change: async () => ({ invalidBefore: '' }),
      reset: async () => ({ invalidBefore: '' }),
    },
    challenges: {
      begin: vi.fn(async () => ({ challengeId: 'ch-1' })) as never,
      verify: vi.fn(async () => ({ payload: { adminId: ADMIN_ID } })) as never,
      abort: async () => ({ aborted: true }),
    },
    sessions: {
      sign: vi.fn(async () => 'signed-token'),
      verify: async () => {
        throw new Error('unused');
      },
      validate: async () => null,
      logout: async () => ({ ok: true as const }),
    },
  };
}

function authHarness(identity: AuthRoutesDeps['identity']) {
  const emailIp = guard();
  const ip = guard();
  const deps: AuthRoutesDeps = {
    identity,
    admins: {
      findByEmail: async () => adminRecord,
      find: async () => adminRecord,
      touchLastLogin: async () => undefined,
    },
    guards: { emailIp, ip },
    loginAudit: async () => undefined,
    trustedProxyHops: 0,
    mailerConfigured: false,
    sessionTtlSec: 3600,
  };
  return { app: withErrorFace(authRoutes(deps)), emailIp, ip };
}

describe('TOTP 登录第二因子', () => {
  it('绑定后 login 不再发邮箱码(即使开关开着):{twoFactorRequired, method:totp} 且无 challengeId', async () => {
    const m = mfa({ confirmed: true });
    const identity = baseIdentity(m);
    const { app } = authHarness(identity);
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tokenlens.dev', password: 'correct horse' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ twoFactorRequired: true, method: 'totp' });
    expect(identity.challenges.begin).not.toHaveBeenCalled();
  });

  it('login/totp:码对签发 token;码错 401 + 双闸计数', async () => {
    const bad = mfa({ confirmed: true, verifyError: identityErrors.business('invalid_totp_code') });
    const { app, emailIp, ip } = authHarness(baseIdentity(bad));
    const res = await app.request('/v1/auth/login/totp', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        email: 'ops@tokenlens.dev',
        password: 'correct horse',
        code: '000000',
      }),
    });
    expect(res.status).toBe(403); // identity.invalid_totp_code 目录口径(category=forbidden)
    expect(emailIp.failures).toBe(1);
    expect(ip.failures).toBe(1);

    const good = mfa({ confirmed: true });
    const { app: app2 } = authHarness(baseIdentity(good));
    const res2 = await app2.request('/v1/auth/login/totp', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        email: 'ops@tokenlens.dev',
        password: 'correct horse',
        code: '123456',
      }),
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ token: 'signed-token', adminId: ADMIN_ID });
    expect(good.verify).toHaveBeenCalledWith({ userId: ADMIN_ID, code: '123456' });
  });

  it('login/totp:未绑定(漂移窗口)按凭据不存在 401;密码错走原口径', async () => {
    const unbound = mfa({ confirmed: false });
    const { app } = authHarness(baseIdentity(unbound));
    const res = await app.request('/v1/auth/login/totp', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        email: 'ops@tokenlens.dev',
        password: 'correct horse',
        code: '123456',
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'admin.invalid_credentials_admin' } });

    const wrongPwd = baseIdentity(mfa({ confirmed: true }));
    wrongPwd.passwords.authenticate = async () => {
      throw identityErrors.business('invalid_credentials', { realm: 'admin' });
    };
    const { app: app2 } = authHarness(wrongPwd);
    const res2 = await app2.request('/v1/auth/login/totp', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tokenlens.dev', password: 'wrong', code: '123456' }),
    });
    expect(res2.status).toBe(401);
  });

  it('login/totp:形状校验(6 位数字或 10 位恢复码字母表)400', async () => {
    const { app } = authHarness(baseIdentity(mfa({ confirmed: true })));
    const res = await app.request('/v1/auth/login/totp', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tokenlens.dev', password: 'x', code: 'abc' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('TOTP 绑定三动词(me 会话组)', () => {
  function meHarness(mfaImpl: ReturnType<typeof mfa>): Hono<SessionEnv> {
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
        mfa: mfaImpl,
        passwords: {
          change: async () => ({ invalidBefore: '' }),
        },
        sessions: { sign: async () => 'signed-token' },
      } as unknown as MeRoutesDeps['identity'],
      admins: {
        find: async () => adminRecord,
        setTwoFactorEnabled: async () => undefined,
      },
      mailerConfigured: false,
      sessionTtlSec: 3600,
    };
    return withErrorFace(meRoutes(deps));
  }

  it('enroll:返回 secret + otpauthUrl(标签带邮箱);无会话 401', async () => {
    const m = mfa({ confirmed: false });
    const app = meHarness(m);
    const res = await app.request('/v1/me/totp/enroll', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { secret: string; otpauthUrl: string };
    expect(body.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(m.enrollTotp).toHaveBeenCalledWith({ userId: ADMIN_ID, label: 'ops@tokenlens.dev' });

    const noAuth = await app.request('/v1/me/totp/enroll', { method: 'POST', headers: json });
    expect(noAuth.status).toBe(401);
  });

  it('confirm:返回一次性恢复码;disable 须持有效码(无效 400 invalid_totp_code)', async () => {
    const ok = mfa({ confirmed: false });
    const app = meHarness(ok);
    const res = await app.request('/v1/me/totp/confirm', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${VALID_TOKEN}` },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recoveryCodes: ['RVWXYZ2345', 'WVXYZ23456'] });

    const deny = mfa({ confirmed: true, disableResult: false });
    const app2 = meHarness(deny);
    const res2 = await app2.request('/v1/me/totp/disable', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${VALID_TOKEN}` },
      body: JSON.stringify({ code: '000000' }),
    });
    expect(res2.status).toBe(400);
    expect(await res2.json()).toMatchObject({ error: { code: 'admin.invalid_totp_code' } });
  });

  it('GET /v1/me 带 totpEnabled(读面来自 mfa.status)', async () => {
    const app = meHarness(mfa({ confirmed: true }));
    const res = await app.request('/v1/me', {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ totpEnabled: true });
  });
});
