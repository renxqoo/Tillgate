/**
 * 会话 jti 吊销表（identity SessionRevocationStore 的 Redis 实现）：
 * logout 即时下线；键随令牌自然过期自动清理。
 */
import type { Redis } from 'ioredis';
import type { SessionRevocationStore } from '@tokenlens/identity';

const keyOf = (jti: string) => `session:jti:${jti}`;

export function createRedisSessionRevocation(redis: Redis): SessionRevocationStore {
  return {
    async revoke(jti, remainingTtlSec) {
      await redis.set(keyOf(jti), '1', 'EX', Math.max(1, remainingTtlSec));
    },
    async isRevoked(jti) {
      return (await redis.exists(keyOf(jti))) === 1;
    },
  };
}
