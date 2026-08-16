import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../errors.js';
import { csrfProtection } from '../csrf.js';

function makeApp(trustedOrigins: readonly string[] = ['http://localhost:3000', 'http://localhost:3001']) {
  const app = new Hono();
  app.onError(errorHandler());
  app.use('*', csrfProtection({ trustedOrigins }));
  app.post('/api/keys', (c) => c.json({ ok: true }, 201));
  app.post('/api/auth/password', (c) => c.json({ ok: true }));
  app.get('/api/me', (c) => c.json({ ok: true }));
  return app;
}

describe('csrfProtection（03 修复）', () => {
  it('跨源 Origin 的状态变更请求 → 403', async () => {
    const res = await makeApp().request('/api/keys', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CSRF_ORIGIN_DENIED');
  });

  it('跨源 Referer（无 Origin）→ 403', async () => {
    const res = await makeApp().request('/api/auth/password', {
      method: 'POST',
      headers: { referer: 'https://evil.example/path' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('受信 Origin → 放行', async () => {
    const res = await makeApp().request('/api/keys', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(201);
  });

  it('无 Origin 且无 Referer（非浏览器客户端）→ 放行', async () => {
    const res = await makeApp().request('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(201);
  });

  it('安全方法（GET）不校验 Origin', async () => {
    const res = await makeApp().request('/api/me', {
      method: 'GET',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
  });
});


describe('csrfProtection：Origin/Referer 双缺失 + BFF 内部令牌（fail-closed 收口）', () => {
  const base = { trustedOrigins: ['http://localhost:3000'] };
  function appWith(internalToken?: string) {
    const app = new Hono();
    app.onError(errorHandler());
    app.use('*', csrfProtection({ ...base, internalToken }));
    app.post('/x', (c) => c.json({ ok: true }));
    return app;
  }

  it('未配置令牌（兼容期）：双缺失头仍放行', async () => {
    const res = await appWith().request('/x', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('配置令牌：双缺失头且无令牌 → 403 CSRF_TOKEN_REQUIRED', async () => {
    const res = await appWith('t'.repeat(32)).request('/x', { method: 'POST' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('CSRF_TOKEN_REQUIRED');
  });

  it('配置令牌：携带正确 x-internal-token → 放行（BFF 服务端调用）', async () => {
    const token = 't'.repeat(32);
    const res = await appWith(token).request('/x', {
      method: 'POST',
      headers: { 'x-internal-token': token },
    });
    expect(res.status).toBe(200);
  });

  it('配置令牌：错误令牌 → 403；正确 Origin 仍放行（浏览器路径不受影响）', async () => {
    const token = 't'.repeat(32);
    const bad = await appWith(token).request('/x', {
      method: 'POST',
      headers: { 'x-internal-token': 'wrong-token-value-aaaaaaaaaa' },
    });
    expect(bad.status).toBe(403);
    const ok = await appWith(token).request('/x', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(ok.status).toBe(200);
  });
});
