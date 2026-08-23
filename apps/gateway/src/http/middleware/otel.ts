/**
 * OTel 请求 span 中间件（v1 otel.ts 迁移；SDK 面归 @tokenlens/observability 再出口）：
 * 每请求一条 span `METHOD /path`；跳过探针路径；requestId 后挂（span 属性依赖它）。
 * off 模式 no-op（observability initOtel 契约）。
 */
import type { MiddlewareHandler } from 'hono';
import { context, getTracer, trace, SpanStatusCode } from '@tokenlens/observability';
import type { AuthEnv } from './api-key';

const SKIPPED = new Set(['/healthz', '/readyz', '/livez']);

export function otelMiddleware(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (SKIPPED.has(path)) {
      await next();
      return;
    }
    const spanName = `${c.req.method} ${path}`;
    return context.with(
      trace.setSpan(context.active(), getTracer('gateway').startSpan(spanName)),
      async () => {
        const span = trace.getSpan(context.active());
        span?.setAttribute('http.method', c.req.method);
        span?.setAttribute('http.target', path);
        const requestId = c.get('requestId');
        if (requestId != null) span?.setAttribute('request.id', requestId);
        try {
          await next();
          const status = c.res?.status ?? 0;
          span?.setAttribute('http.status_code', status);
          const auth = c.get('auth');
          if (auth != null) {
            span?.setAttribute('user.id', auth.userId);
            if (auth.apiKeyId != null) span?.setAttribute('api_key.id', auth.apiKeyId);
          }
          if (status >= 500) span?.setStatus({ code: SpanStatusCode.ERROR });
        } catch (error) {
          span?.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
          throw error;
        } finally {
          span?.end();
        }
      },
    );
  };
}
