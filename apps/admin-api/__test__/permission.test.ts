/**
 * 动态 RBAC 权限守卫契约测试（ADR-0008;docs/admin-rbac-dynamic/DESIGN §3 方案 B）：
 *   1. guardFactory 构建期校验——未知码拒构建（fail-closed,路由声明笔误不带上线）;
 *   2. 判定链:会话(401 优先) → isSuper 短路 / 码集合包含放行 / 无权 403;
 *   3. 授权面注入:属主回查 grants 进上下文;封禁 401;回查缺省 fail-closed 403;
 *   4. 403 语义:统一 insufficient_permission,上下文只带所需码(不泄漏授权面)。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { errorHandler } from '@tokenlens/http';
import { guardFactory, requireCode } from '../src/http/middleware/permission';
import {
  sessionMiddleware,
  type SessionEnv,
  type SessionValidator,
} from '../src/http/middleware/session';
import { adminErrorCatalog } from '../src/http/error-face';
import { sessionPayload, VALID_TOKEN } from './helpers';

type Owner = SessionValidator['owner'];

function validatorWith(owner?: Owner): SessionValidator {
  return {
    validate: async (token: string) => (token === VALID_TOKEN ? sessionPayload : null),
    ...(owner != null ? { owner } : {}),
  };
}

/** session + guard(code) 组合的探针 app（回显 grants 形态） */
function probeApp(code: string, owner?: Owner) {
  const session = sessionMiddleware(validatorWith(owner));
  const guard = guardFactory(session);
  const app = new Hono<SessionEnv>();
  app.get('/probe', guard(code), (c) => {
    const grants = c.get('grants');
    return c.json({ ok: true, isSuper: grants?.isSuper ?? null, codes: grants?.codes ?? null });
  });
  app.onError((error, c) => errorHandler({ catalog: adminErrorCatalog })(error, c));
  return app;
}

describe('guardFactory 构建期校验', () => {
  it('未知码拒构建（词表外 = 路由声明笔误,不许带病上线）', () => {
    const guard = guardFactory(sessionMiddleware(validatorWith()));
    expect(() => guard('nonsense:read')).toThrowError(/unknown permission code/);
    expect(() => guard('users:fly')).toThrowError(/unknown permission code/);
    expect(() => guard('users:read')).not.toThrow();
    expect(() => guard('admins:delete')).not.toThrow();
  });
});

const ownerOf =
  (isSuper: boolean, codes: string[]): Owner =>
  async () => ({
    status: 0,
    grants: { isSuper, codes },
  });

describe('判定链（会话 → 码 → handler）', () => {
  it('401 优先于 403:无凭据/坏凭据在码判定前拒绝', async () => {
    const app = probeApp('users:read', ownerOf(false, []));
    expect((await app.request('/probe')).status).toBe(401);
    expect(
      (await app.request('/probe', { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
  });

  it('isSuper 短路:全码放行且上下文携带授权面', async () => {
    const app = probeApp('admins:delete', ownerOf(true, []));
    const res = await app.request('/probe', {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, isSuper: true, codes: [] });
  });

  it('码集合包含放行/不包含 403;封禁属主 401;授权面上下文回显', async () => {
    const allowed = probeApp('funds:adjust', ownerOf(false, ['funds:read', 'funds:adjust']));
    const res = await allowed.request('/probe', {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      isSuper: false,
      codes: ['funds:read', 'funds:adjust'],
    });

    const denied = probeApp('funds:recharge', ownerOf(false, ['funds:read']));
    const res2 = await denied.request('/probe', {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res2.status).toBe(403);
    const body = (await res2.json()) as { error: { code: string } };
    expect(body.error.code).toBe('admin.insufficient_permission');

    const banned = probeApp('users:read', async () => ({
      status: 1,
      grants: { isSuper: false, codes: [] },
    }));
    expect(
      (await banned.request('/probe', { headers: { authorization: `Bearer ${VALID_TOKEN}` } }))
        .status,
    ).toBe(401);
  });

  it('fail-closed:属主回查缺省（纯会话校验形态）→ 授权面缺失 → 403', async () => {
    const app = probeApp('users:read');
    const res = await app.request('/probe', {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it('403 上下文只带所需码,不泄漏授权面事实', async () => {
    const app = probeApp('settings:update', ownerOf(false, ['settings:read']));
    const res = await app.request('/probe', {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const text = JSON.stringify(await res.json());
    expect(text).toContain('settings:update');
    expect(text).not.toContain('settings:read');
  });
});

/** 无捕获的授权注入链（模块级——lint 纪律） */
const grantsChain: MiddlewareHandler<SessionEnv> = async (c, next) => {
  c.set('grants', { isSuper: false, codes: ['ops:read'] });
  await next();
};

describe('requireCode（单码直挂形态）', () => {
  it('已过会话的上下文内判定;未知码构建期抛错', async () => {
    expect(() => requireCode('nope:nope')).toThrowError(/unknown permission code/);
    const app = new Hono<SessionEnv>();
    app.use('/x', grantsChain);
    app.get('/x', requireCode('ops:read'), (c) => c.json({ ok: true }));
    app.get('/y', grantsChain, requireCode('growth:update'), (c) => c.json({ ok: true }));
    app.onError((error, c) => errorHandler({ catalog: adminErrorCatalog })(error, c));
    expect((await app.request('/x')).status).toBe(200);
    expect((await app.request('/y')).status).toBe(403);
  });
});
