/**
 * 管理员邀请一次性令牌 + 重发冷却(Redis):32 字节随机 base64url 令牌,
 * SHA-256 为键存 adminId,TTL 30 分钟(与 C 端找回令牌同窗口);消费用 GETDEL
 * 原子单次——重放第二次即失效。冷却 SET NX EX 60s(发送前占用,投递失败不释放
 * ——防 SMTP 故障时连点重试打爆发件通道)。
 * 键空间 admininvite:token:<hash> / admininvite:cooldown:<id>;与登录守卫、
 * jti 吊销面同库不同前缀,互不影响。client-api redis-reset-token 同构。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export const ADMIN_INVITE_TOKEN_TTL_SECONDS = 30 * 60;
export const ADMIN_INVITE_TOKEN_TTL_MINUTES = 30;
export const ADMIN_INVITE_RESEND_COOLDOWN_S = 60;

export interface AdminInviteStore {
  /** 签发:返回一次性令牌明文(仅本次返回,入库只存哈希) */
  issue(adminId: number): Promise<string>;
  /** 消费:原子单次(GETDEL);有效返回 adminId,无效/过期/已用返回 null */
  consume(token: string): Promise<number | null>;
  /** 重发冷却占用:SET NX EX——true=占用成功(可发),false=冷却中(429) */
  tryStartCooldown(adminId: number): Promise<boolean>;
}

const tokenKey = (token: string) =>
  `admininvite:token:${createHash('sha256').update(token).digest('hex')}`;
const cooldownKey = (adminId: number) => `admininvite:cooldown:${adminId}`;

export function createRedisAdminInviteStore(redis: Redis): AdminInviteStore {
  return {
    async issue(adminId) {
      const token = randomBytes(32).toString('base64url');
      await redis.set(tokenKey(token), String(adminId), 'EX', ADMIN_INVITE_TOKEN_TTL_SECONDS);
      return token;
    },
    async consume(token) {
      const raw = await redis.getdel(tokenKey(token));
      const adminId = raw == null ? NaN : Number(raw);
      return Number.isInteger(adminId) ? adminId : null;
    },
    async tryStartCooldown(adminId) {
      const ok = await redis.set(
        cooldownKey(adminId),
        '1',
        'EX',
        ADMIN_INVITE_RESEND_COOLDOWN_S,
        'NX',
      );
      return ok === 'OK';
    },
  };
}
