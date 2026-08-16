import type { Redis } from 'ioredis';
import type {
  BreakerState,
  BreakerStorage,
  DeadCredentialState,
  DeadCredentialStorage,
} from '@ai-gateway/ai';

/**
 * ai 包状态持久化的 Redis 实现（gateway 注入 ai 包的 BreakerStorage / DeadCredentialStorage）。
 *
 * 核心是 compareAndSet 的原子性——用 Lua 脚本保证 GET+条件SET 不可拆分（防多实例竞态）：
 *   - 脚本经 RedisScriptRunner 执行（evalsha + NOSCRIPT 自愈，BUG-C）：
 *     读 key → 解析 version → 匹配 expectedVersion → SET next PX ttl → 返回 1/0
 *   - Lua 在 Redis 单线程内原子执行，多实例并发下只有一个赢家成功
 *
 * 两个接口（Breaker/DeadCredential）结构同构（getState/compareAndSet/setState + version 字段），
 * 共用一个泛型实现，通过工厂函数分别产出两个 typed adapter。
 */
import { RedisScriptRunner } from './redis-script-runner.js';

/** 带 version 字段的状态类型（CAS 依据） */
interface Versioned {
  version: number;
}

/** key 前缀，避免 breaker / dead-credential 的 key 空间冲突 */
const PREFIX_BREAKER = 'ai:breaker:';
const PREFIX_CREDENTIAL = 'ai:credential:';

// Lua 脚本：原子 compareAndSet
// KEYS[1] = redis key
// ARGV[1] = expectedVersion (number)
// ARGV[2] = nextJson (string)
// ARGV[3] = ttlMs (number)
// 返回 1 = 成功；0 = version 不匹配
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

/**
 * 泛型 Redis KV 存储：实现 getState / compareAndSet / setState。
 * T 必须带 version 字段（BreakerState / DeadCredentialState 均满足）。
 */
export class RedisKvStorage<T extends Versioned> {
  private readonly scripts: RedisScriptRunner;

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {
    this.scripts = new RedisScriptRunner(redis);
  }

  async getState(key: string): Promise<T | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(this.prefix + key);
    } catch {
      // 存储故障 = 状态未知（null）：熔断/死凭据按「无已知状态」放行，
      // 计数降级内存——Redis 故障不得把全渠道判死（fail-open，与限流同语义）
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async compareAndSet(
    key: string,
    expectedVersion: number,
    next: T,
    ttlMs: number,
  ): Promise<boolean> {
    const res = (await this.scripts
      .run(
        CAS_SCRIPT,
        1,
        this.prefix + key,
        expectedVersion,
        JSON.stringify(next),
        ttlMs,
      )
      .catch(() => 0)) as number;
    return res === 1;
  }

  async setState(key: string, state: T, ttlMs: number): Promise<void> {
    await this.redis
      .set(this.prefix + key, JSON.stringify(state), 'PX', ttlMs)
      .catch(() => {
        /* best-effort：状态写失败只影响本实例降级期的精度 */
      });
  }
}

/**
 * 创建 BreakerStorage 的 Redis 实现。
 * gateway 启动时注入 createAi({ ... }, { breakerStorage: createRedisBreakerStorage(redis) })
 */
export function createRedisBreakerStorage(redis: Redis): BreakerStorage {
  return new RedisKvStorage<BreakerState>(redis, PREFIX_BREAKER);
}

/**
 * 创建 DeadCredentialStorage 的 Redis 实现。
 * 可与 breaker 共用同一 Redis 连接（key 前缀隔离）。
 */
export function createRedisDeadCredentialStorage(redis: Redis): DeadCredentialStorage {
  return new RedisKvStorage<DeadCredentialState>(redis, PREFIX_CREDENTIAL);
}
