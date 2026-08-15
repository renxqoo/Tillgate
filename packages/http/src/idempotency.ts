import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { HttpError } from './errors.js';

/**
 * 幂等操作键：优先取 idempotency-key 请求头，缺失时生成 UUID。
 * 资金类写操作（调账/赠送等）统一走此入口，消除散落的路由级重复。
 *
 * 命名空间隔离（T1 修复）：fund_operations.operationId 是全局主键，同时承载
 * 客户键与系统自然键（signup-gift:{id} / redeem:{hash}:{uid} / ch-review:{rid} …）。
 * 系统键一律含 ':'，客户端键因此被限制为不含 ':' 的安全字符集——结构性上
 * 不可能抢占/污染系统键（投毒 signup-gift:{victimId} 曾导致受害者登录永久 500）。
 */
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function operationId(c: Context): string {
  const key = c.req.header('idempotency-key');
  if (key === undefined || key === '') return randomUUID();
  if (!CLIENT_KEY_RE.test(key)) {
    throw new HttpError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'idempotency-key 只允许 1-64 位字母/数字/下划线/中划线（不得含冒号等系统命名空间字符）',
    );
  }
  return key;
}
