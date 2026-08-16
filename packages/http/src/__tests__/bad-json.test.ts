import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { errorHandler, jsonBody } from '../index.js';

/**
 * W2 红测：坏 JSON 请求体必须 400 INVALID_JSON（客户端可预期错误），
 * 不得作为未处理异常 500。hono validator('json') 在 JSON.parse 失败时抛
 * SyntaxError，errorHandler 必须在边界层翻译（原则 6：错误语义分级）。
 */

describe('errorHandler：坏 JSON → 400', () => {
  const app = new Hono();
  app.onError(errorHandler());
  app.post('/x', jsonBody(z.object({ a: z.string() })), (c) => c.json({ ok: true }));

  it('非法 JSON 体 → 400 INVALID_JSON', async () => {
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('INVALID_JSON');
  });

  it('合法 JSON 但字段不符 → 400 VALIDATION_ERROR（既有行为不回归）', async () => {
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 123 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });
});
