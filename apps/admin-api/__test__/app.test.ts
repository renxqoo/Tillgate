import { describe, expect, it } from 'vitest';
import { createAdminApp } from '../src/app';
import { fakeDeps } from './helpers';

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
