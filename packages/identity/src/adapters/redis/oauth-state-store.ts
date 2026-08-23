/**
 * OAuth state Redis 实现:单值 SETEX + GETDEL 单次消费(不可达由调用方 fail-closed
 * 拒绝,本适配器原样上抛)。redis 参数为结构化最小接口(不编译依赖 ioredis)。
 */
import type { OAuthStatePayload, OAuthStateStore } from '../../ports/oauth-state-store.js';

export interface RedisStateClient {
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

export function createRedisOAuthStateStore(
  redis: RedisStateClient,
  options: { prefix?: string } = {},
): OAuthStateStore {
  const prefix = options.prefix ?? 'oauth:state';
  return {
    async save(state, payload, ttlS) {
      await redis.set(`${prefix}:${state}`, JSON.stringify(payload), 'EX', ttlS);
    },
    async consume(state) {
      const raw = await redis.getdel(`${prefix}:${state}`);
      return raw ? (JSON.parse(raw) as OAuthStatePayload) : null;
    },
  };
}
