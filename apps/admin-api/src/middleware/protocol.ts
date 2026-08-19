/**
 * 协议中间件三件套：请求 ID / CORS 预检 / 安全头 / 请求体上限。
 * 与 client-api 同一套语义（管理面无 Cookie，CORS 仅服务管理台前端）。
 */
import { randomUUID } from 'node:crypto';
import { bodyLimit as honoBodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { SessionEnv } from './session.js';

/** requestId 永远服务端生成（randomUUID），不信任客户端头 */
export function requestIdMiddleware(): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    c.set('requestId', randomUUID());
    await next();
    c.header('x-request-id', c.get('requestId'));
  };
}

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
