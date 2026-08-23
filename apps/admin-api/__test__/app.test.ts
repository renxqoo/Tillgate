import { describe, expect, it } from 'vitest';
import { identityErrors } from '@tokenlens/identity';
import { createAdminApp } from '../src/app';
import { authHeader, fakeDeps } from './helpers';

/**
 * app 骨架契约（v1 app.test.ts 行为规格子集）:探针豁免鉴权 / livez 纯 200 /
 * 未知路径 404 信封 / 命名空间错误码渲染。
 */

describe('admin-api app 骨架', () => {
  it('healthz:DB 通 = 200;断 = 503(探针豁免鉴权,无 Bearer)', async () => {
    const ok = createAdminApp(fakeDeps({}));
    const resOk = await ok.request('/healthz');
    expect(resOk.status).toBe(200);
    expect(await resOk.json()).toEqual({ ok: true });

    const down = createAdminApp(
      fakeDeps({
        pingDb: async () => {
          throw new Error('pg down');
        },
      }),
    );
    const resDown = await down.request('/healthz');
    expect(resDown.status).toBe(503);
    expect(await resDown.json()).toMatchObject({ ok: false });
  });

  it('livez 纯 200(不触 DB);readyz 查 DB', async () => {
    const app = createAdminApp(fakeDeps({}));
    expect((await app.request('/livez')).status).toBe(200);
    const ready = await app.request('/readyz');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', dependencies: { postgres: 'up' } });
  });

  it('未知路径 404 统一信封(不泄漏路由清单)', async () => {
    const app = createAdminApp(fakeDeps({}));
    const res = await app.request('/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'http.not_found', message: 'Path not found' },
    });
  });

  it('未注册的 /v1 路径 404 而非 401(会话逐路由挂载——v1 语义)', async () => {
    const app = createAdminApp(fakeDeps({}));
    const res = await app.request('/v1/unknown-resource');
    expect(res.status).toBe(404);
  });

  it('P2 登录面经 createAdminApp 挂载(auth/me 未挂载即 404——装配缺位回归锁)', async () => {
    // auth:凭据错走 401 invalid_credentials(路由未挂载时表现为 404 not_found)
    const base = fakeDeps({});
    const app = createAdminApp({
      ...base,
      identity: {
        ...base.identity,
        passwords: {
          ...base.identity.passwords,
          authenticate: async () => {
            throw identityErrors.business('invalid_credentials', { realm: 'admin' });
          },
        },
      },
    });
    const login = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ops@tokenlens.dev', password: 'wrong' }),
    });
    expect(login.status).toBe(401);
    expect(await login.json()).toMatchObject({ error: { code: 'identity.invalid_credentials' } });

    // me:会话有效回显资料(路由未挂载时表现为 404 not_found)
    const meApp = createAdminApp(
      fakeDeps({
        controlPlane: {
          admins: {
            find: async () => ({
              id: 7,
              email: 'ops@tokenlens.dev',
              displayName: 'Ops',
              status: 0,
              role: 'super_admin' as const,
              twoFactorEnabled: false,
              lastLoginAt: null,
              createdAt: new Date(0),
            }),
          },
        },
      }),
    );
    const me = await meApp.request('/v1/me', { headers: authHeader() });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: 7, email: 'ops@tokenlens.dev' });
  });

  it('安全响应头全集', async () => {
    const app = createAdminApp(fakeDeps({}));
    const res = await app.request('/livez');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('响应回显服务端 x-request-id', async () => {
    const app = createAdminApp(fakeDeps({}));
    const res = await app.request('/livez');
    expect(res.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/);
  });
});
