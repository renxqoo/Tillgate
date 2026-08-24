import type Redis from 'ioredis';
import type { HealthStore, Versioned } from '../ports/state';

/**
 * Redis CAS 存储（v1 packages/core redis/ai-storages.ts 迁移，前缀改 inference:health:）：
 * Lua 原子 compareAndSet（GET + 条件 SET PX）；值 JSON 序列化。
 * 读失败/坏值返回 null（fail-open——健康状态尽力而为，不得反噬请求路径）。
 */
const CAS_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local expected = tonumber(ARGV[1])
if raw then
  local ok, state = pcall(cjson.decode, raw)
  if not ok or type(state) ~= 'table' or state.version ~= expected then
    return 0
  end
  redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
  return 1
end
if expected == 0 then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
  return 1
end
return 0`;

export function createRedisHealthStore(redis: Redis, prefix: string): HealthStore {
  return {
    async getState<T extends Versioned>(key: string): Promise<T | null> {
      const raw = await redis.get(prefix + key);
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null; // 坏值 fail-open（按无状态处理）
      }
    },
    // eslint-disable-next-line max-params -- 实现 HealthStore 端口契约(键/期望版本/新值/TTL),签名随端口走
    async compareAndSet<T extends Versioned>(
      key: string,
      expectedVersion: number,
      next: T,
      ttlMs: number,
    ): Promise<boolean> {
      const result = await redis.eval(
        CAS_SCRIPT,
        1,
        prefix + key,
        String(expectedVersion),
        JSON.stringify(next),
        String(ttlMs),
      );
      return result === 1;
    },
  };
}
