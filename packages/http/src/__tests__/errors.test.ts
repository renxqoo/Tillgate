import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HttpError, errorHandler, errorResponseBody } from '../errors.js';
import { ValidationError, jsonBody, query } from '../validation.js';
import { z } from 'zod';

describe('统一错误模型', () => {
  it('errorResponseBody：无 details 时不输出 details 字段', () => {
    const body = errorResponseBody(new HttpError('USER_NOT_FOUND', 'User not found'));
    expect(body).toEqual({ error: { message: 'User not found', code: 'USER_NOT_FOUND' } });
  });

  it('errorResponseBody：带 details 时输出', () => {
    const body = errorResponseBody(new HttpError('VALIDATION_ERROR', 'Invalid request parameters', [{ path: 'body.a', reason: 'x' }]));
    expect(body.error.details).toEqual([{ path: 'body.a', reason: 'x' }]);
  });

  it('errorHandler：HttpError → 对应状态码 + 统一响应体', async () => {
    const app = new Hono();
    app.onError(errorHandler());
    app.get('/boom', () => {
      throw new HttpError('ORG_FORBIDDEN', 'Admin privileges required');
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { message: 'Admin privileges required', code: 'ORG_FORBIDDEN' } });
  });

  it('errorHandler：未知错误 → 500 INTERNAL_ERROR 且记日志', async () => {
    const logged: Array<Record<string, unknown>> = [];
    const app = new Hono();
    app.onError(errorHandler({ error: (obj) => logged.push(obj) }));
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } });
    expect(logged.length).toBe(1);
  });

  it('jsonBody 校验失败 → 400 VALIDATION_ERROR + details', async () => {
    const app = new Hono();
    app.onError(errorHandler());
    app.post('/x', jsonBody(z.object({ name: z.string().min(3) })), (c) => c.json({ ok: true }));
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: Array<{ path: string }> } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details[0]!.path).toBe('body.name');
  });

  it('query 校验失败 → 400 VALIDATION_ERROR，path 前缀 query', async () => {
    const app = new Hono();
    app.onError(errorHandler());
    app.get('/x', query(z.object({ n: z.coerce.number().int() })), (c) => c.json({ ok: true }));
    const res = await app.request('/x?n=abc');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: Array<{ path: string }> } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details[0]!.path).toBe('query.n');
  });

  it('ValidationError 是 HttpError 子类', () => {
    const err = new ValidationError([{ path: 'body', reason: 'x' }]);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});
