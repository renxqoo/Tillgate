import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { adminAuthMiddleware } from './admin-auth.js';
import { signSession, SESSION_COOKIE } from '../lib/session.js';

/**
 * admin-api 鉴权中间件：
 *   - 机器令牌（S4）：Authorization: Bearer <ADMIN_API_TOKEN> 或 X-Admin-Token
 *   - 管理员会话（§5）：HttpOnly Cookie 中 role=1 的面板 JWT（注入 db + jwtSecret 后可用）
 *   - 任一通过即放行；都无效 → 401；都没配置 → 503
 *
 * 这里只测中间件本身的鉴权分流；会话回查 DB 的部分由集成测试覆盖（unit 不连库）。
 */
const SECRET = 'test-jwt-secret-0123456789';

function makeApp(opts: { token?: string; jwtSecret?: string }) {
  const app = new Hono();
  // 注入一个假的 Cookie（db 参数留空 → 会话路径无法通过 DB 回查，会落到 fail）
  app.use('/api/admin/*', adminAuthMiddleware(opts.token, undefined, opts.jwtSecret));
  app.get('/api/admin/users', (c) => c.json({ ok: true }));
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  return app;
}

function withSessionCookie(token: string): Record<string, string> {
  // 模拟浏览器 Cookie 头
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

describe('admin-api 鉴权中间件', () => {
  describe('机器令牌（API Token）', () => {
    it('无凭证 → 401', async () => {
      const app = makeApp({ token: 'secret-admin-token' });
      const res = await app.request('/api/admin/users');
      expect(res.status).toBe(401);
    });

    it('错误凭证 → 401', async () => {
      const app = makeApp({ token: 'secret-admin-token' });
      const res = await app.request('/api/admin/users', {
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });

    it('正确 Bearer 凭证 → 200', async () => {
      const app = makeApp({ token: 'secret-admin-token' });
      const res = await app.request('/api/admin/users', {
        headers: { authorization: 'Bearer secret-admin-token' },
      });
      expect(res.status).toBe(200);
    });

    it('X-Admin-Token 头 → 200', async () => {
      const app = makeApp({ token: 'secret-admin-token' });
      const res = await app.request('/api/admin/users', {
        headers: { 'x-admin-token': 'secret-admin-token' },
      });
      expect(res.status).toBe(200);
    });

    it('非管理路径不拦截（/healthz）', async () => {
      const app = makeApp({ token: 'secret-admin-token' });
      const res = await app.request('/healthz');
      expect(res.status).toBe(200);
    });
  });

  describe('管理员会话（Cookie JWT）', () => {
    it('有效管理员会话 Cookie 但无 db 注入 → 走机器令牌失败 → 401', async () => {
      // 无 db 注入时会话路径无法完成 DB 回查，应被拒（这里验证：只有 token 配置时 Cookie 不算数）
      const app = makeApp({ token: 'secret-admin-token' });
      const session = await signSession({ userId: 1, role: 1 }, SECRET);
      const res = await app.request('/api/admin/users', { headers: withSessionCookie(session) });
      // token 与 cookie 都不一致/无 db 回查 → 401
      expect(res.status).toBe(401);
    });

    it('普通用户 role=0 的会话，即使有效也不会被接受为管理员（无 db）', async () => {
      const app = makeApp({ token: undefined, jwtSecret: SECRET });
      const session = await signSession({ userId: 1, role: 0 }, SECRET);
      const res = await app.request('/api/admin/users', { headers: withSessionCookie(session) });
      expect(res.status).toBe(401);
    });
  });

  describe('fail-closed', () => {
    it('未配置 token 且未配置 jwtSecret → 503', async () => {
      const app = makeApp({});
      const res = await app.request('/api/admin/users', {
        headers: { authorization: 'Bearer anything' },
      });
      expect(res.status).toBe(503);
    });

    it('配置了 jwtSecret 但无 token、无 Cookie → 401（非 503，因为会话路径可用）', async () => {
      const app = makeApp({ jwtSecret: SECRET });
      const res = await app.request('/api/admin/users');
      expect(res.status).toBe(401);
    });

    it('空 Token 字符串 + 无 jwtSecret → 503', async () => {
      const app = makeApp({ token: '' });
      const res = await app.request('/api/admin/users', {
        headers: { authorization: 'Bearer ' },
      });
      expect(res.status).toBe(503);
    });
  });

  describe('优先级：机器令牌优先', () => {
    it('有机器令牌即放行（即便 Cookie 无效）', async () => {
      const app = makeApp({ token: 'real-token' });
      const res = await app.request('/api/admin/users', {
        headers: { authorization: 'Bearer real-token', cookie: `${SESSION_COOKIE}=garbage` },
      });
      expect(res.status).toBe(200);
    });
  });
});
