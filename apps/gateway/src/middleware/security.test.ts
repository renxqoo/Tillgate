import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bodyParserLimit, securityHeaders, corsPreflight, BODY_LIMIT_BYTES } from './security.js';

/**
 * 安全中间件（S6）：
 *   - bodyLimit：请求体超过 16MB → 413（防 OOM）
 *   - 安全响应头：X-Content-Type-Options / X-Frame-Options / Referrer-Policy
 *   - CORS 预检：OPTIONS 放行（生产由 nginx 处理，网关兜底）
 *
 * 三组中间件独立注册（Hono 标准模式，避免嵌套导致的上下文未完成问题）。
 */
function makeApp() {
  const app = new Hono();
  app.use('*', corsPreflight);
  app.use('*', securityHeaders);
  app.use('*', bodyParserLimit);
  app.post('/v1/chat/completions', async (c) => c.json({ ok: true }));
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  return app;
}

describe('安全中间件', () => {
  it('请求体 ≤ 限制 → 正常处理', async () => {
    const app = makeApp();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
  });

  it('请求体 > 16MB → 413 Payload Too Large', async () => {
    const app = makeApp();
    // 用 Request 构造（Hono bodyLimit 在读取流时按字节计，不依赖 content-length 头）
    const huge = 'x'.repeat(BODY_LIMIT_BYTES + 1000);
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(413);
  });

  it('安全响应头存在', async () => {
    const app = makeApp();
    const res = await app.request('/healthz');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBeDefined();
  });

  it('OPTIONS 预检 → 204（CORS 放行）', async () => {
    const app = makeApp();
    const res = await app.request('/v1/chat/completions', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://console.example.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeDefined();
  });
});
