import type { MiddlewareHandler } from 'hono';
import { getTracer } from '@ai-gateway/otel';
import { SpanStatusCode } from '@opentelemetry/api';
import type { AuthEnv } from './auth.js';
import { recordError } from '../lib/metrics.js';

/**
 * OTel HTTP 入口中间件：为每个请求创建 Span（tech-stack §3.1）。
 * SDK 未启动时（OTEL_ENABLED=false）为 no-op tracer，无性能开销。
 *
 * Span 属性：http.method/http.route/http.status_code/duration_ms
 * 鉴权后补充：user_id/credential_type（从 c.var.auth）
 */
export function otelMiddleware(): MiddlewareHandler<AuthEnv> {
  const tracer = getTracer('gateway.http');
  return async (c, next) => {
    const span = tracer.startSpan(`${c.req.method} ${new URL(c.req.url).pathname}`);
    span.setAttributes({
      'http.method': c.req.method,
      'http.target': c.req.url,
    });

    try {
      await next();
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err as Error);
      throw err;
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
