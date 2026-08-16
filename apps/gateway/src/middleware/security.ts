import type { MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { HttpError } from '../lib/http.js';

/**
 * 安全中间件（S6）：
 *   - bodyLimit：请求体超过上限 → 413（防 OOM）
 *   - secureHeaders：X-Content-Type-Options:nosniff / X-Frame-Options / Referrer-Policy 等
 *   - CORS 预检兜底：OPTIONS 放行（生产主要由 nginx 处理，网关兜底防中间件链阻塞预检）
 *
 * tech-stack §5：请求体 16MB 上限；tech-stack §7：安全头基线。
 */
export const BODY_LIMIT_BYTES = 16 * 1024 * 1024; // 16MB

/**
 * 请求体大小限制中间件（工厂：测试可注入小上限）。
 *
 * 两层防护：
 *   - content-length 预判：超限直接 413，不触碰 body（零开销快路径）
 *   - chunked（无 content-length）：包一层计数流透传 body，超限即中断
 *     （HttpError(413) 从 body 读取处冒出 → onError 统一转错误信封）
 *
 * 不缓冲 body（流式透传），不影响 SSE 响应逐块推送。
 */
export function bodyParserLimit(maxBytes: number = BODY_LIMIT_BYTES): MiddlewareHandler {
  return async (c, next) => {
    const rawContentLength = c.req.header('content-length');
    if (rawContentLength !== undefined && !/^\d+$/.test(rawContentLength)) {
      throw new HttpError('invalid_content_length', 'Content-Length 必须是非负整数');
    }
    const cl = Number(rawContentLength ?? '0');
    if (cl > maxBytes) {
      return c.json(
        {
          error: {
            message: '请求体过大（超过 16MB 限制）',
            type: 'invalid_request_error',
            code: 'request_too_large',
          },
        },
        413,
      );
    }
    // chunked（无 content-length，仅带 body 的写方法）：包计数流，超限中断
    const method = c.req.method.toUpperCase();
    const mayHaveBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
    if (mayHaveBody && c.req.header('content-length') === undefined && c.req.raw.body) {
      // 显式传 method：new Request 重放 body 必须与写方法配套
      c.req.raw = new Request(c.req.raw, {
        method: c.req.method,
        body: countLimitedBody(c.req.raw.body, maxBytes),
        duplex: 'half',
      });
    }
    await next();
  };
}

/**
 * 计数透传流：边读边数，超过 max 即中断（抛 HttpError(413)，
 * 由下游 body 读取处（json validator）冒泡到 app.onError）。
 */
function countLimitedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            controller.error(
              new HttpError('request_too_large', '请求体过大（超过 16MB 限制）'),
            );
            return;
          }
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        await reader.cancel().catch(() => {});
        controller.error(err);
      }
    },
  });
}

/** 安全响应头中间件 */
export const securityHeaders = secureHeaders({
  xContentTypeOptions: 'nosniff',
  xFrameOptions: 'DENY',
  referrerPolicy: 'no-referrer',
});

/** CORS 只回显受信控制台来源；非浏览器 API 调用不受影响。 */
export function corsPreflight(allowedOrigins: readonly string[] = []): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && allowedOrigins.includes(origin)) {
      c.header('access-control-allow-origin', origin);
      c.header('vary', 'Origin');
    }
    if (c.req.method === 'OPTIONS') {
      if (!origin || !allowedOrigins.includes(origin)) {
        throw new HttpError('cors_origin_denied', '不允许的浏览器来源');
      }
      c.header('access-control-allow-methods', 'GET, POST, OPTIONS');
      c.header('access-control-allow-headers', 'Authorization, Content-Type, X-Request-Id');
      c.header('access-control-max-age', '86400');
      return c.body(null, 204);
    }
    await next();
  };
}
