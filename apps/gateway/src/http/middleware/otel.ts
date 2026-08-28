/**
 * OTel 请求 span 中间件（SDK 面归 @tillgate/observability 再出口）：
 * 每请求一条 span `METHOD /path`；跳过探针路径；requestId 后挂（span 属性依赖它）。
 * off 模式 no-op（observability initOtel 契约）。
 */
import type { MiddlewareHandler } from 'hono';
import { context, getTracer, trace, SpanStatusCode, type Span } from '@tillgate/observability';
import type { AuthContext, AuthEnv } from './api-key';

const SKIPPED = new Set(['/healthz', '/readyz', '/livez']);

/** 请求后观察回填：状态码 + 鉴权属性 + ≥5xx 置 ERROR（观察面旁路，不碰数据面） */
function observeResponse(span: Span | undefined, auth: AuthContext | undefined, status: number) {
  span?.setAttribute('http.status_code', status);
  if (auth != null) {
    span?.setAttribute('user.id', auth.userId);
    if (auth.apiKeyId != null) span?.setAttribute('api_key.id', auth.apiKeyId);
  }
  if (status >= 500) span?.setStatus({ code: SpanStatusCode.ERROR });
}

export function otelMiddleware(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const { path } = c.req;
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
          observeResponse(span, c.get('auth'), c.res?.status ?? 0);
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
