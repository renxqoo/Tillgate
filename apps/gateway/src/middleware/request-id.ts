import type { MiddlewareHandler } from 'hono';
import { randomUUID } from 'node:crypto';
import type { AuthEnv } from './auth.js';

/**
 * request_id 中间件：为每个请求生成服务端唯一 ID。
 *
 * 安全（S1）：requestId 永远服务端生成（randomUUID），**不信任客户端 X-Request-Id**。
 *   - 限流 ZSET 用 requestId 作 member（rate-limit.ts），若信任客户端头 →
 *     攻击者固定发同一 ID → ZADD 去重为 1 → 绕过 RPM。
 *   - 同理 requestId 还是 BullMQ jobId + usage_logs 幂等键，客户端控制会导致计量去重错乱。
 *   - 客户端 X-Request-Id 仅用于日志关联（不入 requestId，不进限流/计量/幂等）。
 */
export const requestIdMiddleware = (): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const id = randomUUID();
  c.set('requestId', id);
  await next();
  c.header('x-request-id', id);
};
