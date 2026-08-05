import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { adminAuthMiddleware } from './admin-auth.js';
import { signSession, SESSION_COOKIE } from '../lib/session.js';

/**
 * admin-api 鉴权中间件：
 *   - 仅管理员会话（§5）：HttpOnly Cookie 中 role=1 的面板 JWT
 *   - 无效或缺失 → 401
 *
 * 这里只测中间件本身的鉴权分流；会话回查 DB 的部分由集成测试覆盖（unit 不连库）。
 */
const SECRET = 'test-jwt-secret-0123456789';

function makeApp(jwtSecret: string) {
  const app = new Hono();
  // mock db：checkAdminSession 回查 users 表时返回空（模拟"用户不存在"→ 401）
  const mockDb = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
  } as never;
  app.use('/api/admin/*', adminAuthMiddleware(mockDb, jwtSecret));
  app.get('/api/admin/users', (c) => c.json({ ok: true }));
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  return app;
}

function withSessionCookie(token: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

describe('admin-api 鉴权中间件（仅会话鉴权）', () => {
  it('无凭证 → 401', async () => {
    const app = makeApp(SECRET);
    const res = await app.request('/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('非管理路径不拦截（/healthz）', async () => {
    const app = makeApp(SECRET);
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('有 Cookie 但无 db 注入 → DB 回查失败 → 401', async () => {
    const app = makeApp(SECRET);
    const session = await signSession({ userId: 1, role: 1 }, SECRET);
    const res = await app.request('/api/admin/users', { headers: withSessionCookie(session) });
    expect(res.status).toBe(401);
  });

  it('普通用户 role=0 的会话 → 401', async () => {
    const app = makeApp(SECRET);
    const session = await signSession({ userId: 1, role: 0 }, SECRET);
    const res = await app.request('/api/admin/users', { headers: withSessionCookie(session) });
    expect(res.status).toBe(401);
  });

  it('机器令牌不再被接受（Bearer header → 401）', async () => {
    const app = makeApp(SECRET);
    const res = await app.request('/api/admin/users', {
      headers: { authorization: 'Bearer any-token' },
    });
    expect(res.status).toBe(401);
  });
});
