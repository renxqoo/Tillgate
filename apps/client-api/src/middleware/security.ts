/**
 * 安全中间件三件套：CORS 预检 / 安全头 / 请求体上限（413 提前拒绝）。
 * CORS 白名单装配注入（逗号分隔 env）；空表 = 不放行任何跨域。
 * 用户面 API 请求体都是小 JSON（无多模态透传），上限远小于网关。
 */
import { bodyLimit as honoBodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { SessionEnv } from './session.js';

/** 请求体上限：按实际流过字节计数（chunked 传输编码同样受限——只查长度头可被绕过） */
export function bodyParserLimit(maxBytes: number): MiddlewareHandler<SessionEnv> {
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
  }) as MiddlewareHandler<SessionEnv>;
}

export const securityHeaders: MiddlewareHandler<SessionEnv> = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
};

export function corsPreflight(allowedOrigins: readonly string[]): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin != null && allowedOrigins.includes(origin)) {
      if (c.req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': origin,
            Vary: 'Origin',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          },
        });
      }
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
    await next();
  };
}
