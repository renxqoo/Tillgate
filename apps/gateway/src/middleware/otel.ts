import type { MiddlewareHandler } from 'hono';
import { getTracer, context, trace } from '@ai-gateway/core';
import { SpanStatusCode } from '@opentelemetry/api';
import type { AuthEnv } from './auth.js';
import { recordError } from '../lib/metrics.js';

/**
 * OTel HTTP 入口中间件：为每个请求创建 Span（tech-stack §3.1）。
 * SDK 未启动时（OTEL_TRACES_MODE=off）为 no-op tracer，无性能开销。
 *
 * Span 属性：http.method/http.route/http.status_code/duration_ms
 * 鉴权后补充：user_id/credential_type（从 c.var.auth）
 *
 * 上下文传播：next() 包在 context.with 里，请求执行期间（含管线创建的
 * billing/upstream span 与流式收尾 span）都以本 span 为父——
 * 「一次请求一条 trace」的前提。
 */
export function otelMiddleware(): MiddlewareHandler<AuthEnv> {
  const tracer = getTracer('gateway.http');
  return async (c, next) => {
    // 健康检查/本地调试页不产 span（探活噪音会淹没真实请求 trace）
    const path = new URL(c.req.url).pathname;
    if (path === '/readyz' || path === '/healthz' || path.startsWith('/debug/')) {
      return next();
    }
    const span = tracer.startSpan(`${c.req.method} ${new URL(c.req.url).pathname}`);
    span.setAttributes({
      'http.method': c.req.method,
      'http.target': c.req.url,
      // 计费关联锚点：接收端提升为 request_id 索引列（复核页「查链路」）
      ...(c.var.requestId ? { 'request.id': c.var.requestId } : {}),
    });

    try {
      await context.with(trace.setSpan(context.active(), span), async () => {
        try {
          await next();
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          span.recordException(err as Error);
          throw err;
        }
      });
    } finally {
      // 补充鉴权后的属性（如果有）
      try {
        const auth = c.var.auth;
        if (auth) {
          span.setAttributes({
            'user.id': auth.userId,
            'auth.credential_type': auth.credentialType,
          });
        }
      } catch {
        /* c.var.auth 可能未设置（鉴权失败时） */
      }
      span.setAttribute('http.status_code', c.res.status);
      if (c.res.status >= 400) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        recordError(`http_${c.res.status}`);
      }
      span.end();
    }
  };
}
