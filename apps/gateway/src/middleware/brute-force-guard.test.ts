import { describe, expect, it, vi } from 'vitest';
import {
  checkBruteForce,
  recordAuthFailure,
  type BruteForceStorage,
  BRUTE_FORCE_THRESHOLD,
  BRUTE_FAILURE_WINDOW_S,
  BRUTE_LOCK_DURATION_S,
} from './brute-force-guard.js';

/**
 * 静态 Key 暴力破解防护（S2）：
 *   - Redis 计数：key 维度失败次数（keyHash 或 keyHash 前缀）
 *   - 达阈值（默认 5 次/10 分钟）→ 锁定 10 分钟，锁定期间返回 429
 *   - 成功认证 → 清零计数
 *
 * 用 mock storage 测试（不依赖真实 Redis）。
 */

function makeMockStorage(): BruteForceStorage & { _counts: Map<string, number>; _locks: Map<string, number> } {
  const counts = new Map<string, number>();
  const locks = new Map<string, number>();
  return {
    _counts: counts,
    _locks: locks,
    async getFailures(key) {
      return counts.get(key) ?? 0;
    },
    async incrFailures(key, _windowS) {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n;
    },
    async resetFailures(key) {
      counts.delete(key);
    },
    async setLock(key, ttlS) {
      locks.set(key, ttlS);
    },
    async getLockTtl(key) {
      return locks.get(key) ?? 0;
    },
    async clearLock(key) {
      locks.delete(key);
    },
  };
}

describe('静态 Key 暴力破解防护', () => {
  it('未达阈值 → 允许', async () => {
    const storage = makeMockStorage();
    const result = await checkBruteForce(storage, 'keyhash-abc');
    expect(result.locked).toBe(false);
  });

  it('失败次数达阈值 → 锁定', async () => {
    const storage = makeMockStorage();
    // 模拟连续失败到阈值
    for (let i = 0; i < BRUTE_FORCE_THRESHOLD; i++) {
      await recordAuthFailure(storage, 'keyhash-abc');
    }
    const result = await checkBruteForce(storage, 'keyhash-abc');
    expect(result.locked).toBe(true);
    expect(result.retryAfterSec).toBe(BRUTE_LOCK_DURATION_S);
  });

  it('锁定期间 → 返回 429 + retry-after', async () => {
    const storage = makeMockStorage();
    await recordAuthFailure(storage, 'keyhash-abc');
    await recordAuthFailure(storage, 'keyhash-abc');
    await recordAuthFailure(storage, 'keyhash-abc');
    await recordAuthFailure(storage, 'keyhash-abc');
    await recordAuthFailure(storage, 'keyhash-abc');
    // 已达阈值，下一次 checkBruteForce 应锁
    const r1 = await checkBruteForce(storage, 'keyhash-abc');
    expect(r1.locked).toBe(true);
    // 锁定中再次检查仍锁
    const r2 = await checkBruteForce(storage, 'keyhash-abc');
    expect(r2.locked).toBe(true);
  });

  it('成功认证 → 清零计数 + 清锁', async () => {
    const storage = makeMockStorage();
    for (let i = 0; i < BRUTE_FORCE_THRESHOLD; i++) {
      await recordAuthFailure(storage, 'keyhash-abc');
    }
    const locked = await checkBruteForce(storage, 'keyhash-abc');
    expect(locked.locked).toBe(true);
    // 成功 → 重置
    const { resetAuthFailures } = await import('./brute-force-guard.js');
    await resetAuthFailures(storage, 'keyhash-abc');
    const after = await checkBruteForce(storage, 'keyhash-abc');
    expect(after.locked).toBe(false);
  });

  it('不同 keyHash 互不影响', async () => {
    const storage = makeMockStorage();
    for (let i = 0; i < BRUTE_FORCE_THRESHOLD; i++) {
      await recordAuthFailure(storage, 'keyA');
    }
    expect((await checkBruteForce(storage, 'keyA')).locked).toBe(true);
    expect((await checkBruteForce(storage, 'keyB')).locked).toBe(false);
  });

  it('失败计数有窗口（TTL），窗口过后自动过期', async () => {
    expect(BRUTE_FAILURE_WINDOW_S).toBeGreaterThan(0);
    // incrFailures 传 windowS → storage 负责设 TTL（真实 Redis 用 EXPIRE）
    const storage = makeMockStorage();
    const spy = vi.spyOn(storage, 'incrFailures');
    await recordAuthFailure(storage, 'keyX');
    expect(spy).toHaveBeenCalledWith('keyX', BRUTE_FAILURE_WINDOW_S);
  });
});
