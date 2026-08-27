/**
 * 分支补面（覆盖率 90/85 门槛——仅补测试）：
 * identity 审计桥映射（actor 前缀归一/数值归属）、session 属主回查三态、
 * me/auth 未走分支（资料行缺失/2FA 开启成功/凭据行与资料行漂移/payload 无 adminId）、
 * config P2 新键缺省与 SMTP 组边界。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { errorHandler } from '@tillgate/http';
import { sessionMiddleware, type SessionEnv } from '../src/http/middleware/session';
import { createIdentityAuditSinkBridge } from '../src/adapters/identity-audit-bridge';
import { authRoutes } from '../src/http/routes/auth';
import * as usersRoutesRef from '../src/http/routes/users';
import { meRoutes, type MeRoutesDeps } from '../src/http/routes/me';
import { ADMIN_FACE_OVERRIDES, adminErrorCatalog } from '../src/http/error-face';
import { loadAdminApiConfig } from '../src/config';
import { mfaStub } from './helpers';

const json = { 'content-type': 'application/json' };
const TOKEN = 'tok';
const ADMIN_ID = 7;

function bare(): Hono<SessionEnv> {
  const app = authRoutes({
    identity: {
      mfa: mfaStub(),
      passwords: {
        authenticate: async () => ({ userId: ADMIN_ID }),
        change: async () => ({ invalidBefore: 'x' }),
        reset: async () => ({ invalidBefore: 'x' }),
      },
      challenges: {
        begin: (async () => ({ challengeId: 'c' })) as never,
        verify: (async () => ({ payload: {} })) as never,
        abort: async () => ({ aborted: true }),
      },
      sessions: {
        sign: async () => 't',
        verify: async () => {
          throw new Error('u');
        },
        validate: async () => null,
        logout: async () => ({ ok: true as const }),
      },
    },
    admins: {
      findByEmail: async () => null,
      find: async () => null,
      touchLastLogin: async () => {},
    },
    guards: {
      emailIp: {
        isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
        recordFailure: async () => {},
        recordSuccess: async () => {},
      },
      ip: {
        isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
        recordFailure: async () => {},
      },
    },
    loginAudit: async () => {},
    trustedProxyHops: 0,
    mailerConfigured: () => false,
    sessionTtlSec: 3600,
  });
  app.onError((error, c) =>
    errorHandler({ catalog: adminErrorCatalog, overrides: ADMIN_FACE_OVERRIDES })(error, c),
  );
  return app;
}

describe('identity 审计桥', () => {
  it('actor 前缀归一(admin:N→admin/其余→system)+adminId 数值归属+detail 透传/缺省', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const sink = createIdentityAuditSinkBridge(async (_db, entry) => {
      seen.push(entry as unknown as Record<string, unknown>);
    });
    await sink.record({} as never, {
      action: 'password.change',
      at: '2026-08-23T00:00:00Z',
      actor: 'admin:7',
      targetType: 'admin',
      targetId: 7,
    });
    await sink.record({} as never, {
      action: 'challenge.begin',
      at: '2026-08-23T00:00:00Z',
      actor: 'system',
      targetType: 'challenge',
      targetId: 'c-1',
      detail: { kind: 'admin_login_code' },
    });
    expect(seen[0]).toMatchObject({
      actor: 'admin',
      adminId: 7,
      action: 'identity.password.change',
    });
    expect(seen[1]).toMatchObject({
      actor: 'system',
      adminId: null,
      action: 'identity.challenge.begin',
      detail: { kind: 'admin_login_code' },
    });
  });
});

describe('session 属主回查（D8/W3）', () => {
  async function appWithOwner(
    // 未注入 owner = 纯会话校验形态;可选参数以支持零参调用
    owner?: () => Promise<{ status: number; grants: { isSuper: boolean; codes: string[] } } | null>,
  ) {
    const app = new (await import('hono')).Hono<SessionEnv>();
    app.use(
      '*',
      sessionMiddleware({
        validate: async () => ({
          realm: 'admin',
          sub: String(ADMIN_ID),
          jti: 'j',
          iss: 'i',
          exp: 9,
          iat: 1,
        }),
        ...(owner != null ? { owner } : {}),
      }),
    );
    app.get('/probe', (c) => c.json({ ok: true, adminId: c.get('adminId') }));
    app.onError((error, c) => errorHandler({ catalog: adminErrorCatalog })(error, c));
    return app.request('/probe', { headers: { authorization: `Bearer ${TOKEN}` } });
  }

  it('属主存在且 status=0 放行;不存在/封禁一律 401;未注入 owner 时纯会话校验放行', async () => {
    const ok = await appWithOwner(async () => ({
      status: 0,
      grants: { isSuper: true, codes: [] },
    }));
    expect(ok.status).toBe(200);
    const missing = await appWithOwner(async () => null);
    expect(missing.status).toBe(401);
    const banned = await appWithOwner(async () => ({
      status: 1,
      grants: { isSuper: true, codes: [] },
    }));
    expect(banned.status).toBe(401);
    const noOwner = await appWithOwner();
    expect(noOwner.status).toBe(200);
  });

  it('非 Bearer/验签失败统一 401', async () => {
    const app = new (await import('hono')).Hono<SessionEnv>();
    app.use('*', sessionMiddleware({ validate: async () => null }));
    app.get('/probe', (c) => c.json({ ok: true }));
    app.onError((error, c) => errorHandler({ catalog: adminErrorCatalog })(error, c));
    const noHeader = await app.request('/probe');
    expect(noHeader.status).toBe(401);
    const invalid = await app.request('/probe', { headers: { authorization: 'Bearer x' } });
    expect(invalid.status).toBe(401);
  });
});

describe('auth/me 未走分支', () => {
  it('凭据行存在但资料行漂移 → invalid_credentials_admin 401', async () => {
    const app = bare();
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tillgate.dev', password: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'admin.invalid_credentials_admin' } });
  });

  it('verify payload 无 adminId → invalid_credentials_admin', async () => {
    const app = bare();
    const res = await app.request('/v1/auth/login/verify', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ challengeId: '0b1a2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d', code: '123456' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'admin.invalid_credentials_admin' } });
  });

  it('me:资料行缺失 401 admin_not_found;2FA 开启成功路径(SMTP 已配)回显开关', async () => {
    const meDeps: MeRoutesDeps = {
      twoFactorAudit: async () => {},
      trustedProxyHops: 0,
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
          begin: (async () => ({ challengeId: 'c' })) as never,
          verify: (async () => ({ target: {}, payload: {} })) as never,
          abort: async () => ({ aborted: true }),
        },
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => ({ userId: 0 }),
          change: async () => ({ invalidBefore: 'x' }),
          reset: async () => ({ invalidBefore: 'x' }),
        },
        sessions: {
          sign: async () => 't',
          verify: async () => {
            throw new Error('u');
          },
          validate: async () => null,
          logout: async () => ({ ok: true as const }),
        },
      },
      admins: { find: async () => null, setTwoFactorEnabled: async () => {} },
      sessionTtlSec: 3600,
    };
    const app = meRoutes(meDeps);
    app.onError((error, c) => errorHandler({ catalog: adminErrorCatalog })(error, c));
    const missing = await app.request('/v1/me', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'admin.admin_not_found' } });

    const enable = await app.request('/v1/me/two-factor', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        enabled: true,
        challengeId: '11111111-1111-4111-8111-111111111111',
        code: '123456',
      }),
    });
    expect(enable.status).toBe(200);
    expect(await enable.json()).toEqual({ twoFactorEnabled: true });
    const disable = await app.request('/v1/me/two-factor', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        enabled: false,
        challengeId: '11111111-1111-4111-8111-111111111111',
        code: '123456',
      }),
    });
    expect(await disable.json()).toEqual({ twoFactorEnabled: false });
  });

  it('登录成功但 touch/审计为 best-effort 分支（audit 拒绝不阻断登录）', async () => {
    const app = authRoutes({
      mailerConfigured: () => false,
      identity: {
        mfa: mfaStub(),
        passwords: {
          authenticate: async () => ({ userId: ADMIN_ID }),
          change: async () => ({ invalidBefore: 'x' }),
          reset: async () => ({ invalidBefore: 'x' }),
        },
        challenges: {
          begin: (async () => ({ challengeId: 'c' })) as never,
          verify: (async () => ({ payload: {} })) as never,
          abort: async () => ({ aborted: true }),
        },
        sessions: {
          sign: async () => 'signed',
          verify: async () => {
            throw new Error('u');
          },
          validate: async () => null,
          logout: async () => ({ ok: true as const }),
        },
      },
      admins: {
        findByEmail: async () => ({
          id: ADMIN_ID,
          email: 'ops@tillgate.dev',
          displayName: null,
          status: 0,
          roleId: 1,
          role: 'super_admin',
          twoFactorEnabled: false,
          lastLoginAt: null,
          createdAt: new Date(0),
        }),
        find: async () => null,
        touchLastLogin: async () => {},
      },
      guards: {
        emailIp: {
          isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
          recordFailure: async () => {},
          recordSuccess: async () => {},
        },
        ip: {
          isLocked: async () => ({ locked: false, retryAfterSec: 0 }),
          recordFailure: async () => {},
        },
      },
      loginAudit: async () => {
        throw new Error('audit down');
      },
      trustedProxyHops: 0,
      sessionTtlSec: 3600,
    });
    app.onError((error, c) =>
      errorHandler({ catalog: adminErrorCatalog, overrides: ADMIN_FACE_OVERRIDES })(error, c),
    );
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ops@tillgate.dev', password: 'x' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: 'signed', adminId: ADMIN_ID });
  });
});

describe('config P2 新键', () => {
  const BASE = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    ADMIN_JWT_SECRET: 'admin-jwt-secret-0123456789-abcdef',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'user-jwt-secret-0123456789-abcdef',
    ENCRYPTION_KEY: 'encryption-key-0123456789-abcdef',
    IDENTITY_CODE_PEPPER: 'pepper-0123456789',
  };

  it('缺省值装配（SMTP 组已迁 integration_settings——config 面无 smtp 字段）', () => {
    const cfg = loadAdminApiConfig({ ...BASE } as NodeJS.ProcessEnv);
    expect(cfg.trustedProxyHops).toBe(0);
    expect(cfg.loginGuard).toEqual({ failureThreshold: 5, failureWindowS: 3600, lockS: 900 });
    expect(cfg.ipGuard).toEqual({ limit: 30, windowS: 3600 });
    expect('smtp' in cfg).toBe(false);
  });

  it('REDIS_URL/JWT_SECRET 缺失 fail-fast', () => {
    expect(() =>
      loadAdminApiConfig({ ...BASE, REDIS_URL: undefined } as NodeJS.ProcessEnv),
    ).toThrow();
    expect(() =>
      loadAdminApiConfig({ ...BASE, JWT_SECRET: undefined } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});

const EMPTY_PRICE_HISTORY = async () => [] as never[];

void vi;

describe('users set-password（D6 分支面）', () => {
  const { usersRoutes } = usersRoutesRef;

  function usersHarness(overrides: {
    issuer?: string;
    rateCardId?: number | null;
    cards?: Array<{ id: number; name: string }>;
    coefficient?: string | null;
  }) {
    const patch = vi.fn(async () => ({ id: 3 }) as never);
    const reset = vi.fn(async () => ({ invalidBefore: 'x' }));
    const updateCard = vi.fn(async () => ({ ok: true }) as never);
    const postAudit = vi.fn(async () => {});
    const deps = {
      accounts: {
        adminListUsers: async () => ({ rows: [], total: 0 }),
        adminGetUser: async () =>
          ({
            id: 3,
            email: 'u@x',
            displayName: null,
            status: 0,
            freezeReason: null,
            issuer: overrides.issuer ?? 'local',
            subject: 's',
            identityProvider: 'local',
            rateCardId: overrides.rateCardId ?? null,
            balance: null,
            creditLimit: null,
            rpmLimit: null,
            tpmLimit: null,
            dailySpendLimit: null,
            isEnterprise: false,
            createdAt: new Date(0),
            lastLoginAt: null,
            statusReason: null,
          }) as never,
        adminPatchUser: patch,
      },
      wallet: { accounts: async () => [], setCreditLimit: async () => ({ ok: true }) as never },
      identity: { passwords: { reset } },
      rates: {
        listCards: async () =>
          ({ rows: overrides.cards ?? [{ id: 11, name: '标准' }], total: 1 }) as never,
        updateCard,
        findGlobalCoefficient: async () => overrides.coefficient ?? null,
      },
      postAudit,
    };
    const app = usersRoutes(deps as never);
    app.onError((error, c) => errorHandler({ catalog: adminErrorCatalog })(error, c));
    return { app, patch, reset, updateCard, postAudit };
  }

  it('本地账号+未绑卡+缺系数:回填 1.000 → 绑卡 → reset(user realm) → 审计', async () => {
    const h = usersHarness({ rateCardId: null, coefficient: null });
    const res = await h.app.request('/v1/users/3/set-password', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ password: 'new-pass-123' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.updateCard).toHaveBeenCalledWith(
      expect.objectContaining({ rateCardId: 11, patch: { coefficient: '1.000' } }),
    );
    expect(h.patch).toHaveBeenCalledWith(expect.objectContaining({ patch: { rateCardId: 11 } }));
    expect(h.reset).toHaveBeenCalledWith({ userId: 3, realm: 'user', newPassword: 'new-pass-123' });
    expect(h.postAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.set_password', targetId: 3 }),
    );
  });

  it('已绑卡跳过绑卡;系数已在不覆盖;非本地账号 400 not_local_account', async () => {
    const h = usersHarness({ rateCardId: 99, coefficient: '0.800' });
    const res = await h.app.request('/v1/users/3/set-password', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ password: 'new-pass-123' }),
    });
    expect(res.status).toBe(200);
    expect(h.updateCard).not.toHaveBeenCalled();
    expect(h.patch).not.toHaveBeenCalled();
    expect(h.reset).toHaveBeenCalledTimes(1);

    const oidc = usersHarness({ issuer: 'github' });
    const res2 = await oidc.app.request('/v1/users/3/set-password', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ password: 'new-pass-123' }),
    });
    expect(res2.status).toBe(400);
    expect(await res2.json()).toMatchObject({ error: { code: 'admin.not_local_account' } });
  });
});

describe('P6/P5 残余分支（价格溯源参数边界/通知词表边界）', () => {
  it('price-history:externalName 缺失/空串/超长一律 400;合法值透传', async () => {
    const { catalogRoutes } = await import('../src/http/routes/catalog');
    const app = catalogRoutes({
      controlPlane: {
        catalog: {
          listSources: () => [],
          priceHistory: EMPTY_PRICE_HISTORY,
          comparison: async () => ({}) as never,
          import: async () => ({}) as never,
        },
      },
      vendorCatalog: { protocols: [], vendors: [] },
    } as never);
    app.onError((error, c) => errorHandler({ catalog: adminErrorCatalog })(error, c));
    for (const qs of ['', '?externalName=', `?externalName=${'x'.repeat(65)}`]) {
      const res = await app.request(`/v1/model-catalog/price-history${qs}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'admin.invalid_param' } });
    }
    const ok = await app.request('/v1/model-catalog/price-history?externalName=gpt-x', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ entries: [] });
    // 未知目录源 404(catalogSourceParam 词表外)
    const missing = await app.request('/v1/model-catalog/nope!!', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.status).toBe(404);
  });

  it('notifications 契约:email 渠道 recipients 上界/secret 下界/type 词表外 400', async () => {
    const { notificationsContracts } = await import('../src/http/contracts/notifications');
    expect(
      notificationsContracts.create.safeParse({
        name: 'x',
        type: 'email',
        config: { recipients: Array.from({ length: 21 }, () => 'a@b.co') },
        events: ['billing_dead'],
      }).success,
    ).toBe(false);
    expect(
      notificationsContracts.create.safeParse({
        name: 'x',
        type: 'sms',
        config: { recipients: ['a@b.co'] },
        events: ['billing_dead'],
      }).success,
    ).toBe(false);
    expect(
      notificationsContracts.create.safeParse({
        name: 'x',
        type: 'webhook',
        config: { url: 'https://h.example/x', secret: 'short' },
        events: ['billing_dead'],
      }).success,
    ).toBe(false);
    expect(notificationsContracts.update.safeParse({ type: 'email' }).success).toBe(false);
  });
});
