/**
 * 幂等操作键：优先取 idempotency-key 请求头，缺失时生成 UUID。
 * 资金类写操作统一走此入口，消除散落的路由级重复。
 *
 * 命名空间隔离：operationId 是全局主键，同时承载客户端键与系统自然键
 * （signup-gift:{id} / redeem:{hash}:{uid} / ch-review:{rid} …）。系统键一律含 ':'，
 * 客户端键因此被限制为不含 ':' 的安全字符集——结构性上不可能抢占/污染系统键
 * （若可投毒 signup-gift:{受害者id} 会导致受害者登录永久 500）。
 */
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { HttpErrors } from '../errors/catalog';

const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function operationId(c: Context): string {
  const key = c.req.header('idempotency-key');
  if (key === undefined || key === '') return randomUUID();
  if (!CLIENT_KEY_RE.test(key)) {
    throw HttpErrors.business('invalid_idempotency_key', { length: key.length });
  }
  return key;
}
