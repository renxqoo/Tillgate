/**
 * OTel HTTP 入口中间件（v1 语义移植）：每请求一条 Span（探活路径除外），
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
      span.setAttributes({ 'http.status_code': c.res?.status ?? 0 });
      if ((c.res?.status ?? 200) >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      span.end();
    }
  };
}
