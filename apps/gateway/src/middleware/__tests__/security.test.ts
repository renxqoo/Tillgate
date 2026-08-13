import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bodyParserLimit, securityHeaders, corsPreflight, BODY_LIMIT_BYTES } from '../security.js';
import { appErrorHandler } from '../../app.js';
import { createLogger } from '@ai-gateway/core';

/**
 * 安全中间件（S6）：
 *   - bodyLimit：请求体超过上限 → 413（防 OOM；content-length 预判 + chunked 计数流双防护）
 *   - 安全响应头：X-Content-Type-Options / X-Frame-Options / Referrer-Policy
 *   - CORS 预检：OPTIONS 放行（生产由 nginx 处理，网关兜底）
 */
const silentLogger = createLogger({ level: 'silent' });

function makeApp(limit?: number) {
  const app = new Hono();
  app.onError((err, c) => appErrorHandler(silentLogger, err, c));
  app.use('*', corsPreflight(['https://console.example.com']));
  app.use('*', securityHeaders);
  app.use('*', bodyParserLimit(limit));
  app.post('/v1/chat/completions', async (c) => {
    // 不吞错：超限 HttpError 从这里冒泡 → appErrorHandler → 413
    const body = (await c.req.json()) as { model?: string };
    return c.json({ ok: true, model: body.model });
  });
  app.get('/livez', (c) => c.json({ status: 'ok' }));
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

  it('请求体 > 16MB（带 content-length）→ 413 Payload Too Large', async () => {
    const app = makeApp();
    // content-length 预判（不缓冲 body，保流式响应逐块推送）
    const huge = 'x'.repeat(BODY_LIMIT_BYTES + 1000);
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(huge.length),
      },
      body: huge,
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(413);
  });

  it('chunked（无 content-length）超限 → 413（计数流中断）', async () => {
    const app = makeApp(1024); // 小上限便于测试
    // 无 content-length：node fetch 自动用 chunked transfer-encoding
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(2048)));
        controller.close();
      },
    });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('request_too_large');
  });

  it('chunked（无 content-length）≤ 限制 → 正常读取 body', async () => {
    const app = makeApp(1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: 'small' })));
        controller.close();
      },
    });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { model: string };
    expect(json.model).toBe('small');
  });

  it('安全响应头存在', async () => {
    const app = makeApp();
    const res = await app.request('/livez');
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
