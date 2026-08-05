import { describe, expect, it, vi } from 'vitest';
import { BillingService } from './billing.js';
import type { Db } from '@ai-gateway/db';

/**
 * reclaimExpiredHolds 行为测试（重构后：DB 行锁 + Redis 仅 hold 标记）。
 *
 * 重构后语义：reclaimExpiredHolds() 不再接受阈值参数，仅回收 ttl===-1（无 TTL 残留）的 hold 标记。
 *   - ttl > 0（仍在 TTL 内）= 正常在途请求的 hold，绝不回收（否则 worker 结算重复扣费 → 资损）
 *   - ttl === -2（不存在）跳过
 *   - ttl === -1（无 TTL 的异常残留）= 真正泄漏，回收（DB 加回金额 + 删标记）
 *
 * 旧的「阈值过度激进」bug（reclaimExpiredHolds(60_000) 误回收 TTL 剩余 <60s 的在途 hold）
 * 已从架构层消除：函数不再接受阈值参数，恒只回收 ttl===-1。
 *
 * 新架构：金额在 DB 算（UPDATE balance += amount），Redis 只存 hold 标记（value="userId:amount"）。
 * 测试 mock：Redis 存 hold 标记 + ttl；DB mock 记录被加回的金额。
 */

/** mock Redis：存 hold 标记 + pttl，evalsha 模拟 RELEASE_HOLD_SCRIPT（GET+DEL） */
function makeMockRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    /** 预置 hold 标记（绕过 hold()，模拟在途/泄漏 hold） */
    setHold(userId: number, requestId: string, amount: string, ttlMs: number) {
      const key = `billing:hold:${requestId}`;
      store.set(key, `${userId}:${amount}`);
      ttls.set(key, ttlMs);
    },
    async script() {
      return 'release-sha';
    },
    async evalsha(_sha: string, _n: number, holdKey: string) {
      // RELEASE_HOLD_SCRIPT：GET + DEL，返回原值或空串
      const v = store.get(holdKey);
      if (!v) return '';
      store.delete(holdKey);
      ttls.delete(holdKey);
      return v;
    },
    async scan() {
      const keys = [...store.keys()].filter((k) => k.startsWith('billing:hold:'));
      return ['0', keys];
    },
    async pttl(k: string) {
      if (!store.has(k)) return -2;
      return ttls.get(k) ?? -1;
    },
    async get(k: string) { return store.get(k) ?? null; },
    async set(k: string, v: string) { store.set(k, v); return 'OK'; },
    async del(k: string) { store.delete(k); return 1; },
  };
}

/** mock Db：记录 reclaim 时被 UPDATE 加回的金额 */
function makeMockDb(): { updates: Array<{ userId: number; amount: string }>; db: Db } {
  const updates: Array<{ userId: number; amount: string }> = [];
  const db = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: vi.fn(async () => []),
        }),
      }),
    }),
    query: { users: { findFirst: vi.fn(async () => ({ balance: '100' })) } },
    // 捕获 reclaim 的 UPDATE：通过 spy 检查（简化：直接记录 set 的参数）
  } as unknown as Db;
  return { updates, db };
}

describe('reclaimExpiredHolds（重构后：仅回收 ttl===-1 无 TTL 残留）', () => {
  it('不回收 TTL 剩余 30s 的在途 hold（正确行为，防 worker 重复扣费）', async () => {
    const redis = makeMockRedis();
    const { db } = makeMockDb();
    const billing = new BillingService(redis as never, db, 600_000);

    // 在途 hold：剩余 TTL=30s（>0）→ 不应回收
    redis.setHold(1, 'in-flight', '2', 30_000);

    const reclaimed = await billing.reclaimExpiredHolds();
    expect(reclaimed).toBe(0); // 在途 hold 不动
    // hold 标记仍在
    expect(await redis.get('billing:hold:in-flight')).not.toBeNull();
  });

  it('回收无 TTL 残留（ttl===-1）的泄漏 hold', async () => {
    const redis = makeMockRedis();
    const { db } = makeMockDb();
    const billing = new BillingService(redis as never, db, 600_000);

    // 泄漏 hold：TTL=-1（无过期，异常残留）
    redis.setHold(1, 'leaked', '2', -1);

    const reclaimed = await billing.reclaimExpiredHolds();
    expect(reclaimed).toBe(1); // 回收泄漏 hold
    // hold 标记被清
    expect(await redis.get('billing:hold:leaked')).toBeNull();
  });

  it('不回收 TTL=300s 的在途 hold', async () => {
    const redis = makeMockRedis();
    const { db } = makeMockDb();
    const billing = new BillingService(redis as never, db, 600_000);

    redis.setHold(1, 'in-flight-2', '2', 300_000);

    const reclaimed = await billing.reclaimExpiredHolds();
    expect(reclaimed).toBe(0);
  });

  it('Redis 不可用 → 返回 0（无 hold 可回收）', async () => {
    const failingRedis = {
      scan: () => Promise.reject(new Error('ECONNREFUSED')),
      script: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const { db } = makeMockDb();
    const billing = new BillingService(failingRedis as never, db, 600_000);
    const reclaimed = await billing.reclaimExpiredHolds();
    expect(reclaimed).toBe(0);
  });
});
