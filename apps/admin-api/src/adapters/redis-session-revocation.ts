/**
 * 会话 jti 吊销表（identity SessionRevocationStore 的 Redis 实现,
 * client-api redis-session-revocation 同款——logout 写入 / validate 黑名单读）。
 * 装配面文件:仅 assembly 引用。
 */
import type Redis from 'ioredis';
import type { SessionRevocationStore } from '@tokenlens/identity';

const keyOf = (jti: string) => `admin:session:jti:${jti}`;

export function createAdminSessionRevocation(redis: Redis): SessionRevocationStore {
  return {
    async revoke(jti, remainingTtlSec) {
      await redis.set(keyOf(jti), '1', 'EX', Math.max(1, remainingTtlSec));
    },
    async isRevoked(jti) {
      return (await redis.exists(keyOf(jti))) === 1;
    },
  };
}
