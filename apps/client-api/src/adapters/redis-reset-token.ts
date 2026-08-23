/**
 * 找回密码一次性令牌(Redis):32 字节随机 base64url 令牌,SHA-256 为键存 userId,
 * TTL 30 分钟;消费用 GETDEL 原子单次——重放第二次即失效。
 * 键空间 pwdreset:<hash>;与限频计数器同库不同前缀,互不影响。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export const RESET_TOKEN_TTL_SECONDS = 30 * 60;
export const RESET_TOKEN_TTL_MINUTES = 30;

export interface ResetTokenStore {
  /** 签发:返回一次性令牌明文(仅本次返回,入库只存哈希) */
  issue(userId: number): Promise<string>;
  /** 消费:原子单次(GETDEL);有效返回 userId,无效/过期/已用返回 null */
  consume(token: string): Promise<number | null>;
}

const keyOf = (token: string) => `pwdreset:${createHash('sha256').update(token).digest('hex')}`;

export function createRedisResetTokenStore(redis: Redis): ResetTokenStore {
  return {
    async issue(userId) {
      const token = randomBytes(32).toString('base64url');
      await redis.set(keyOf(token), String(userId), 'EX', RESET_TOKEN_TTL_SECONDS);
      return token;
    },
    async consume(token) {
      const raw = await redis.getdel(keyOf(token));
      const userId = raw == null ? NaN : Number(raw);
      return Number.isInteger(userId) ? userId : null;
    },
  };
}
