import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';

/**
 * 幂等操作键：优先取 idempotency-key 请求头，缺失时生成 UUID。
 * 资金类写操作（调账/赠送等）统一走此入口，消除散落的路由级重复。
 */
export function operationId(c: Context): string {
  return c.req.header('idempotency-key') ?? randomUUID();
}
