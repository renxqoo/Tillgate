/**
 * OTel HTTP 入口中间件：每请求一条 Span（探活路径除外），
 * next() 包在 context.with 里——请求执行期间管线/收据/上游皆以本 span 为父
 * （「一次请求一条 trace」）。SDK 未启动（mode=off）为 no-op tracer，零开销。
 */
import type { MiddlewareHandler } from 'hono';
import { context, getTracer, trace, SpanStatusCode } from '@ai-gateway/core';
import type { AuthEnv } from './api-key.js';

export function otelMiddleware(): MiddlewareHandler<AuthEnv> {
  const tracer = getTracer('gateway.http');
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === '/healthz' || path === '/readyz') return next(); // 探活噪音不入 trace
    const span = tracer.startSpan(`${c.req.method} ${path}`);
    span.setAttributes({
      'http.method': c.req.method,
      'http.target': c.req.url,
      ...(c.var.requestId ? { 'request.id': c.var.requestId } : {}), // 计费关联锚点
    });
    try {
      await context.with(trace.setSpan(context.active(), span), async () => {
        try {
          await next();
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        }
      });
      // 鉴权中间件在 next() 内完成——回到这里时 c.var.auth 已就绪，补根 span 关联列
      const auth = c.var.auth;
      span.setAttributes({
        'http.status_code': c.res?.status ?? 0,
        ...(auth
          ? {
              'user.id': auth.userId,
              ...(auth.apiKeyId != null ? { 'api_key.id': auth.apiKeyId } : {}),
            }
          : {}),
      });
      if ((c.res?.status ?? 200) >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      span.end();
    }
  };
}
