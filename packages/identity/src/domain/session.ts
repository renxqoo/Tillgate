/**
 * 会话令牌契约(HS256 无状态 JWT;机制实现见 adapters/jwt)。
 *
 * realm 隔离:每 realm 独立 issuer/密钥/TTL(装配注入),验签三重校验
 * (算法白名单 + issuer 强校验 + 载荷 realm 比对)——一个 realm 的密钥泄露
 * 不波及其它 realm,同 numeric id 的 user/admin 互不串号。
 *
 * iatMs 毫秒精度自定义声明:会话失效线需要亚秒级——标准 iat 只有秒分辨率,
 * 同一秒内「改密 vs 重新登录」无法区分。
 */
import { identityErrors } from './errors.js';

export interface SessionPayload {
  readonly realm: string;
  /** subject:主体 id(字符串化;消费方自管其含义——users.id / admins.id) */
  readonly sub: string;
  readonly jti: string;
  readonly iss: string;
  readonly exp: number;
  readonly iat: number;
  readonly iatMs?: number;
}

export type SessionVerifyFailureReason = 'invalid_token' | 'token_expired' | 'realm_mismatch';

export type SessionVerifyResult =
  | { readonly ok: true; readonly payload: SessionPayload }
  | { readonly ok: false; readonly reason: SessionVerifyFailureReason };

export interface SessionRealmConfig {
  readonly issuer: string;
  readonly secret: string;
  readonly ttlSec: number;
}

export const SESSION_TTL_BOUNDS = [60, 2_592_000] as const;

export function assertSessionTtlSec(ttlSec: number): number {
  if (
    !Number.isInteger(ttlSec) ||
    ttlSec < SESSION_TTL_BOUNDS[0] ||
    ttlSec > SESSION_TTL_BOUNDS[1]
  ) {
    throw identityErrors.business('invalid_input', {
      field: 'ttlSec',
      reason: `must be an integer in [${SESSION_TTL_BOUNDS[0]}, ${SESSION_TTL_BOUNDS[1]}]`,
    });
  }
  return ttlSec;
}

/** iat 归一:接受 Date 或 epoch 毫秒(锚点线比较口径;NaN 拒绝) */
export function iatMsOf(iat: Date | number): number {
  const ms = iat instanceof Date ? iat.getTime() : iat;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw identityErrors.business('invalid_input', {
      field: 'iat',
      reason: 'must be a Date or epoch milliseconds',
    });
  }
  return ms;
}
