import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { adminAuthMiddleware } from './admin-auth.js';
import { signSession, ADMIN_SESSION_COOKIE, SESSION_COOKIE } from '../lib/session.js';

/**
 * admin-api 鉴权中间件（拆分后）：
 *   - 仅管理员会话（type='admin'）：HttpOnly Cookie 中 ag_admin_session 的管理面 JWT
 *   - 回查 admins 表（非 users.role），无 db 注入/管理员不存在 → 401
 *   - 用户 token（ag_session，type='user'）天然被拒（issuer/type 不符）
 *
 * 这里只测中间件本身的鉴权分流；会话回查 DB 的部分由集成测试覆盖（unit 不连库）。
 */
const SECRET = 'test-jwt-secret-0123456789';

function makeApp(jwtSecret: string) {
  const app = new Hono();
  // mock db：adminAuthMiddleware 回查 admins 表时返回空（模拟"管理员不存在"→ 401）
  const mockDb = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
  } as never;
  app.use('/api/admin/*', adminAuthMiddleware(mockDb, jwtSecret));
  app.get('/api/admin/users', (c) => c.json({ ok: true }));
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  return app;
}

function withSessionCookie(token: string): Record<string, string> {
  return { cookie: `${ADMIN_SESSION_COOKIE}=${token}` };
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

  it('有管理面 Cookie 但无 db 注入 → DB 回查失败 → 401', async () => {
    const app = makeApp(SECRET);
    const session = await signSession({ type: 'admin', id: 1 }, SECRET);
    const res = await app.request('/api/admin/users', { headers: withSessionCookie(session) });
    expect(res.status).toBe(401);
  });

  it('用户 token（type=user）→ 401（身份隔离，即使放进 ag_admin_session 也被拒）', async () => {
    const app = makeApp(SECRET);
    // 即便用户 token 塞进管理面 cookie，验签时 type/issuer 不符 → invalid → 401
    const session = await signSession({ type: 'user', id: 1 }, SECRET);
    const res = await app.request('/api/admin/users', { headers: withSessionCookie(session) });
    expect(res.status).toBe(401);
  });

  it('用户 cookie（ag_session）不被管理面中间件识别 → 401', async () => {
    const app = makeApp(SECRET);
    const session = await signSession({ type: 'user', id: 1 }, SECRET);
    const res = await app.request('/api/admin/users', {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
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
