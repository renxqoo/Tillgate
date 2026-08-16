import type { Redis } from 'ioredis';

/**
 * 静态 Key 暴力破解防护（S2，requirements 4.2）。
 *
 * 对外提供纯逻辑函数 + Storage 接口（可注入 mock 测试）：
 *   - 失败计数：keyHash 维度，窗口 10 分钟，达阈值（5 次）→ 锁 10 分钟
 *   - 锁定期间拒绝（返回 locked=true + retryAfterSec）
 *   - 成功认证 → 清零计数 + 清锁
 *
 * 真实环境用 Redis 实现（INCR + EXPIRE + SET lock + TTL）。
 */

/** 阈值：连续失败 N 次触发锁定 */
export const BRUTE_FORCE_THRESHOLD = 5;
/** 失败计数窗口（秒） */
export const BRUTE_FAILURE_WINDOW_S = 600; // 10 分钟
/** 锁定时长（秒） */
export const BRUTE_LOCK_DURATION_S = 600; // 10 分钟

const KEY_FAILS = (keyHash: string) => `auth:fails:${keyHash}`;
const KEY_LOCK = (keyHash: string) => `auth:lock:${keyHash}`;

/** Storage 接口（注入 Redis 实现 或 mock） */
export interface BruteForceStorage {
  getFailures(keyHash: string): Promise<number>;
  incrFailures(keyHash: string, windowS: number): Promise<number>;
  resetFailures(keyHash: string): Promise<void>;
  setLock(keyHash: string, ttlS: number): Promise<void>;
  getLockTtl(keyHash: string): Promise<number>;
  clearLock(keyHash: string): Promise<void>;
}

/** Redis 实现（生产用） */
export function createRedisBruteForceStorage(redis: Redis): BruteForceStorage {
  return {
    async getFailures(keyHash) {
      const v = await redis.get(KEY_FAILS(keyHash));
      return v ? Number(v) : 0;
    },
    async incrFailures(keyHash, windowS) {
      const n = await redis.incr(KEY_FAILS(keyHash));
      // 首次设置窗口 TTL（后续 incr 不重设，保持首次窗口起点）
      if (n === 1) await redis.expire(KEY_FAILS(keyHash), windowS);
      return n;
    },
    async resetFailures(keyHash) {
      await redis.del(KEY_FAILS(keyHash));
    },
    async setLock(keyHash, ttlS) {
      await redis.set(KEY_LOCK(keyHash), '1', 'EX', ttlS);
    },
    async getLockTtl(keyHash) {
      return redis.ttl(KEY_LOCK(keyHash));
    },
    async clearLock(keyHash) {
      await redis.del(KEY_LOCK(keyHash));
    },
  };
}

export interface BruteForceCheckResult {
  locked: boolean;
  retryAfterSec: number;
}

/**
 * 检查是否被锁定（请求前调用）。
 * 锁定 = lock key 存在（TTL > 0）或 失败次数已达阈值。
 */
export async function checkBruteForce(
  storage: BruteForceStorage,
  keyHash: string,
): Promise<BruteForceCheckResult> {
  try {
    // 先查显式 lock key（锁定后失败次数可能已过期但锁还在）
    const lockTtl = await storage.getLockTtl(keyHash);
    if (lockTtl > 0) {
      return { locked: true, retryAfterSec: lockTtl };
    }
    // 查失败次数：达阈值则设锁（首次触发锁定）
    const failures = await storage.getFailures(keyHash);
    if (failures >= BRUTE_FORCE_THRESHOLD) {
      await storage.setLock(keyHash, BRUTE_LOCK_DURATION_S);
      return { locked: true, retryAfterSec: BRUTE_LOCK_DURATION_S };
    }
    return { locked: false, retryAfterSec: 0 };
  } catch {
    // 防爆破是尽力而为（防枚举），存储故障 fail-open——
    // Redis 故障不得让鉴权成功的路径整体 500
    return { locked: false, retryAfterSec: 0 };
  }
}

/** 记录认证失败（失败后递增计数） */
export async function recordAuthFailure(
  storage: BruteForceStorage,
  keyHash: string,
): Promise<void> {
  try {
    await storage.incrFailures(keyHash, BRUTE_FAILURE_WINDOW_S);
    // 达阈值即设锁（不等下次 checkBruteForce，立即生效）
    const failures = await storage.getFailures(keyHash);
    if (failures >= BRUTE_FORCE_THRESHOLD) {
      await storage.setLock(keyHash, BRUTE_LOCK_DURATION_S);
    }
  } catch {
    /* best-effort：计数写失败只影响降级期的锁定精度 */
  }
}

/** 成功认证 → 清零计数 + 清锁 */
export async function resetAuthFailures(
  storage: BruteForceStorage,
  keyHash: string,
): Promise<void> {
  try {
    await storage.resetFailures(keyHash);
    await storage.clearLock(keyHash);
  } catch {
    /* best-effort：清零失败等 TTL 自然过期 */
  }
}
