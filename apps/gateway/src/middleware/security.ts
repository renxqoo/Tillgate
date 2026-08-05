import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

/**
 * 安全中间件组合（S6）：
 *   - bodyLimit：请求体超过 16MB → 413（防 OOM；SSE 响应不缓冲不受影响）
 *   - secureHeaders：X-Content-Type-Options:nosniff / X-Frame-Options / Referrer-Policy 等
 *   - CORS 预检兜底：OPTIONS 放行（生产主要由 nginx 处理，网关兜底防中间件链阻塞预检）
 *
 * tech-stack §5：请求体 16MB 上限；tech-stack §7：安全头基线。
 *
 * 用法：app.use('*', securityMiddleware()) —— 内部组合 bodyLimit + secureHeaders + CORS。
 * 注意：bodyLimit 的 onError 返回独立 Response（不走 c.json，避免 Hono 上下文未完成）。
 */
export const BODY_LIMIT_BYTES = 16 * 1024 * 1024; // 16MB

/**
 * bodyLimit 中间件：用 content-length 预判（不缓冲 body）。
 *
 * Hono 的 bodyLimit 会读取/缓冲整个请求体来检查大小，
 * 这破坏了流式 Response 的逐块推送（node-server 的 Response body 被缓冲）。
 * 改用 content-length header 预判：超限直接 413，不触碰 body。
 * 缺点：无 content-length 的 chunked 请求不拦截（罕见，且 bodyLimit 也无法拦截）。
 */
export const bodyParserLimit: MiddlewareHandler = async (c, next) => {
  const cl = Number(c.req.header('content-length') ?? '0');
  if (cl > BODY_LIMIT_BYTES) {
    return new Response(
      JSON.stringify({
        error: {
          message: '请求体过大（超过 16MB 限制）',
          type: 'invalid_request_error',
          code: 'request_too_large',
        },
      }),
      { status: 413, headers: { 'content-type': 'application/json' } },
    );
  }
  await next();
};

/** 安全响应头中间件 */
export const securityHeaders = secureHeaders({
  xContentTypeOptions: 'nosniff',
  xFrameOptions: 'DENY',
  referrerPolicy: 'no-referrer',
});

/** CORS 预检兜底（OPTIONS 放行） */
export const corsPreflight: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    c.header('access-control-allow-origin', '*');
    c.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    c.header('access-control-allow-headers', 'Authorization, Content-Type, X-Request-Id');
    c.header('access-control-max-age', '86400');
    return c.body(null, 204);
  }
  await next();
};

/** 组合中间件（一次性挂载：CORS → bodyLimit → 安全头 → next） */
export function securityMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // CORS 预检优先（可能直接 204 返回）
    if (c.req.method === 'OPTIONS') {
      c.header('access-control-allow-origin', '*');
      c.header('access-control-allow-methods', 'GET, POST, OPTIONS');
      c.header('access-control-allow-headers', 'Authorization, Content-Type, X-Request-Id');
      c.header('access-control-max-age', '86400');
      return c.body(null, 204);
    }
    // bodyLimit：超限返回独立 413 Response（不进 c.json，避免上下文未完成）
    // 通过读取 content-length 预判（比 Hono bodyLimit 更早拦截，不缓冲 body）
    const cl = Number(c.req.header('content-length') ?? '0');
    if (cl > BODY_LIMIT_BYTES) {
      return new Response(
        JSON.stringify({
          error: {
            message: '请求体过大（超过 16MB 限制）',
            type: 'invalid_request_error',
            code: 'request_too_large',
          },
        }),
        { status: 413, headers: { 'content-type': 'application/json' } },
      );
    }
    // 安全响应头
    c.header('x-content-type-options', 'nosniff');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'no-referrer');
    await next();
  };
}
