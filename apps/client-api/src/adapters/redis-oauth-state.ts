/**
 * OAuth state 单次存储（identity OAuthStateStore 的 Redis 实现）：
 * GETDEL 单次消费——重放/过期统一 null（v1 语义；多副本共享）。
 */
import type { Redis } from 'ioredis';
import type { OAuthStatePayload, OAuthStateStore } from '@tokenlens/identity';

const keyOf = (state: string) => `oauth:state:${state}`;

export function createRedisOAuthStateStore(redis: Redis): OAuthStateStore {
  return {
    async save(state, payload: OAuthStatePayload, ttlSec) {
      await redis.set(keyOf(state), JSON.stringify(payload), 'EX', ttlSec);
    },
    async consume(state) {
      const raw = await redis.getdel(keyOf(state));
      return raw == null ? null : (JSON.parse(raw) as OAuthStatePayload);
    },
  };
}
