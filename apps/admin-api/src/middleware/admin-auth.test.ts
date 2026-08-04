import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { adminAuthMiddleware } from './admin-auth.js';

/**
 * admin-api 鉴权中间件（S4）：
 *   - 管理端所有 /api/admin/* 接口必须带有效凭证
 *   - 凭证来源：Authorization: Bearer <ADMIN_API_TOKEN> 或 X-Admin-Token: <ADMIN_API_TOKEN>
 *   - 无凭证 / 错误凭证 → 401
 *   - /healthz 等非管理路径不拦截
 *
 * 一期务实方案：API Token（环境变量 ADMIN_API_TOKEN）。
 * 后续 console 上线后切 HttpOnly Cookie JWT（role=admin）。
 */
function makeApp(token: string | undefined) {
  const app = new Hono();
  app.use('/api/admin/*', adminAuthMiddleware(token));
  app.get('/api/admin/users', (c) => c.json({ ok: true }));
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  return app;
}

describe('admin-api 鉴权中间件', () => {
  it('无凭证 → 401', async () => {
    const app = makeApp('secret-admin-token');
    const res = await app.request('/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('错误凭证 → 401', async () => {
    const app = makeApp('secret-admin-token');
    const res = await app.request('/api/admin/users', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('正确 Bearer 凭证 → 200', async () => {
    const app = makeApp('secret-admin-token');
    const res = await app.request('/api/admin/users', {
      headers: { authorization: 'Bearer secret-admin-token' },
    });
    expect(res.status).toBe(200);
  });

  it('X-Admin-Token 头 → 200', async () => {
    const app = makeApp('secret-admin-token');
    const res = await app.request('/api/admin/users', {
      headers: { 'x-admin-token': 'secret-admin-token' },
    });
    expect(res.status).toBe(200);
  });

  it('非管理路径不拦截（/healthz）', async () => {
    const app = makeApp('secret-admin-token');
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('ADMIN_API_TOKEN 未配置 → 所有管理请求 503（fail-closed）', async () => {
    const app = makeApp(undefined);
    const res = await app.request('/api/admin/users', {
      headers: { authorization: 'Bearer anything' },
    });
    expect(res.status).toBe(503);
  });

  it('空 Token 字符串 → 503（fail-closed，防配置空值绕过）', async () => {
    const app = makeApp('');
    const res = await app.request('/api/admin/users', {
      headers: { authorization: 'Bearer ' },
    });
    expect(res.status).toBe(503);
  });
});
