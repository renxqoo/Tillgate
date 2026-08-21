/**
 * ai 状态存储的 Redis 实现（多副本共享）：
 * compareAndSet 的原子性用 Lua 保证 GET+条件 SET 不可拆分（防多实例竞态）。
 *
 * 存储故障语义（fail-open）：getState 异常返回 null（无已知状态——熔断/死凭据
 * 按「未触发」放行，计数降级内存），写失败 best-effort——Redis 故障不得把
 * 全渠道判死；资金正确性由 DB 硬闸门兜底。
 *
 * 泛型实现不依赖 ai 包类型（T 只需带 version 字段）；typed adapter 由调用方
 * 以 ai 包的 BreakerState / DeadCredentialState 实例化（分层零耦合）。
 */
import type { Redis } from 'ioredis';
import { createRedisScriptRunner } from './script-runner.js';

/** 带 version 字段的状态类型（CAS 依据） */
export interface Versioned {
  version: number;
}

/** key 前缀，避免 breaker / dead-credential 的 key 空间冲突 */
export const AI_STORAGE_PREFIXES = { breaker: 'ai:breaker:', credential: 'ai:credential:' } as const;

// Lua：原子 compareAndSet
// KEYS[1] = redis key；ARGV = [expectedVersion, nextJson, ttlMs]；返回 1 成功 / 0 版本不符
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local curVer = 0
if cur then
  local ok, decoded = pcall(cjson.decode, cur)
  if ok and type(decoded) == 'table' and decoded.version ~= nil then
    curVer = tonumber(decoded.version) or 0
  end
end
if curVer ~= tonumber(ARGV[1]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return 1
`;

/** ai 状态存储契约（结构兼容 ai 包 BreakerStorage / DeadCredentialStorage） */
export interface VersionedStateStorage<T extends Versioned> {
  getState(key: string): Promise<T | null>;
  compareAndSet(key: string, expectedVersion: number, next: T, ttlMs: number): Promise<boolean>;
  setState(key: string, state: T, ttlMs: number): Promise<void>;
}

export function createRedisStateStorage<T extends Versioned>(redis: Redis, prefix: string): VersionedStateStorage<T> {
  const scripts = createRedisScriptRunner(redis);
  return {
    async getState(key: string): Promise<T | null> {
      let raw: string | null;
      try {
        raw = await redis.get(prefix + key);
      } catch {
        return null; // fail-open：状态未知按「无已知状态」
      }
      if (!raw) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },

    async compareAndSet(key, expectedVersion, next, ttlMs): Promise<boolean> {
      const res = (await scripts
        .run(CAS_SCRIPT, 1, prefix + key, expectedVersion, JSON.stringify(next), ttlMs)
        .catch(() => 0)) as number;
      return res === 1;
    },

    async setState(key, state, ttlMs): Promise<void> {
      await redis.set(prefix + key, JSON.stringify(state), 'PX', ttlMs).catch(() => {
        /* best-effort：写失败只影响本实例降级期的精度 */
      });
    },
  };
}
