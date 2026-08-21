/**
 * 请求 ID 中间件：requestId 永远服务端生成（randomUUID），不信任客户端头
 * （信任客户端可控 ID 会击穿一切以它为 member/幂等键的机制）。
 * 响应回显服务端 ID 供支持排查关联。
 */
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { SessionEnv } from './session.js';

export function requestIdMiddleware(): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    c.set('requestId', randomUUID());
    await next();
    c.header('x-request-id', c.get('requestId'));
  };
}
