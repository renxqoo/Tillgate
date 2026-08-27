/** 请求 ID 中间件 */
import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/**
 * requestId **永远服务端生成**（randomUUID），不信任客户端 X-Request-Id：
 *   - 限流 ZSET 用 requestId 作 member——信任客户端头 → 固定同一 ID → ZADD 去重
 *     恒 1 条 → RPM 绕过；TPM 预占 hash 同理。
 *   - requestId 同时是 billing/usage 的幂等键（uuid 列），客户端控制会导致
 *     重放冲突与 500。
 * 客户端 X-Request-Id 仅用于日志关联（不入 requestId）；响应回显服务端 ID。
 */
export function requestIdMiddleware<
  E extends { Variables: { requestId: string } },
>(): MiddlewareHandler<E> {
  return async (c, next) => {
    c.set('requestId', randomUUID());
    await next();
    c.header('x-request-id', c.get('requestId'));
  };
}
