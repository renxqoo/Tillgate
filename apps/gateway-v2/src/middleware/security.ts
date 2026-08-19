/**
 * 安全中间件三件套：CORS 预检 / 安全头 / 请求体上限（400 提前拒绝）。
 * CORS 白名单装配注入（逗号分隔 env）；空表 = 不放行任何跨域。
 */
import { bodyLimit as honoBodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { AuthEnv } from './api-key.js';

const DEFAULT_BODY_LIMIT_BYTES = 10 * 1024 * 1024; // 10 MiB：多模态请求体护栏

/**
 * 请求体上限：按实际流过字节计数（hono bodyLimit）——只查 content-length 头的
 * 旧形态对 Transfer-Encoding: chunked 完全失效（无长度头的巨型包直接进
 * c.req.json() 全量缓冲 = 未认证 OOM 面）。
 */
export function bodyParserLimit(maxBytes: number = DEFAULT_BODY_LIMIT_BYTES): MiddlewareHandler<AuthEnv> {
  const limit = honoBodyLimit({
    maxSize: maxBytes,
    onError: (c) =>
      c.json(
        { error: { code: 'payload_too_large', message: `request body exceeds ${maxBytes} bytes` } },
        413,
      ) as unknown as Response,
  });
  return (async (c, next) => {
    // 快路径：声明的 content-length 超限直接 413（免读流）；流式计数兜底 chunked/谎报
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) {
      return c.json(
        { error: { code: 'payload_too_large', message: `request body exceeds ${maxBytes} bytes` } },
        413,
      );
    }
    return limit(c, next);
  }) as MiddlewareHandler<AuthEnv>;
}

export const securityHeaders: MiddlewareHandler<AuthEnv> = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
};

export function corsPreflight(allowedOrigins: readonly string[]): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin != null && allowedOrigins.includes(origin)) {
      if (c.req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': origin,
            Vary: 'Origin',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-Id',
          },
        });
      }
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
    await next();
  };
}
