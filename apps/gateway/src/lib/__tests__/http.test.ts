import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createLogger } from '@ai-gateway/core';
import { HttpError } from '../http.js';
import { appErrorHandler } from '../../app.js';

/**
 * 错误信封契约（OpenAI 风格）：error.type 按 HTTP 状态映射，
 * 下游 SDK 依赖 type 区分认证/权限/限流/服务端错误——不能全标 invalid_request_error。
 */
const silentLogger = createLogger({ level: 'silent' });

function makeApp() {
  const app = new Hono();
  app.onError((err, c) => appErrorHandler(silentLogger, err, c));
  app.get('/boom/:status', (c) => {
    throw new HttpError(Number(c.req.param('status')), 'boom', 'test error');
  });
  return app;
}

describe('错误信封 error.type 按状态映射', () => {
  it.each([
    [401, 'authentication_error'],
    [402, 'invalid_request_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [429, 'rate_limit_error'],
    [500, 'server_error'],
    [503, 'server_error'],
  ])('%s → type=%s', async (status, expectedType) => {
    const res = await makeApp().request(`/boom/${status}`);
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe(expectedType);
    expect(body.error.code).toBe('boom');
  });

  it('HttpError 携带 suggestion 透传到信封', async () => {
    const app = new Hono();
    app.onError((err, c) => appErrorHandler(silentLogger, err, c));
    app.get('/x', () => {
      throw new HttpError(429, 'rate_limit_exceeded', '请求过于频繁', '请稍后重试');
    });
    const res = await app.request('/x');
    const body = (await res.json()) as { error: { suggestion: string } };
    expect(body.error.suggestion).toBe('请稍后重试');
  });
});
