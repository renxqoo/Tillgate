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
