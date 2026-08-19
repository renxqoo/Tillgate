/**
 * Redis 基建单测（真实 Redis；REDIS_URL 未配置时整套跳过——本地无 Redis 的开发
 * 环境不阻塞门禁，CI/生产形态必跑）。覆盖：CAS 竞态单赢家、滑动窗口超限语义、
 * TPM 预占/释放、爆破防护锁定/清零。
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import {
  createKeyBruteForceGuard,
  createRedisStateStorage,
  createSlidingWindowLimiter,
  AI_STORAGE_PREFIXES,
} from '../index.js';

const url = process.env.REDIS_URL;
const hasRedis = url != null && url !== '';

describe.skipIf(!hasRedis)('Redis 基建', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(url!);
  });
  afterAll(async () => {
    await redis?.quit().catch(() => {});
  });

  it('状态存储 CAS：并发写入只有版本匹配的单赢家', async () => {
    const storage = createRedisStateStorage<{ version: number; open: boolean }>(redis, `${AI_STORAGE_PREFIXES.breaker}test:`);
    const key = `cas-${randomUUID().slice(0, 8)}`;
    expect(await storage.compareAndSet(key, 0, { version: 1, open: true }, 60_000)).toBe(true);
    expect(await storage.compareAndSet(key, 0, { version: 2, open: false }, 60_000)).toBe(false); // 旧版本必输
    const state = await storage.getState(key);
    expect(state).toEqual({ version: 1, open: true });
  });

  it('状态存储 getState：不存在/坏 JSON → null（fail-open 语义）', async () => {
    const storage = createRedisStateStorage<{ version: number }>(redis, 'ai:breaker:test:');
    expect(await storage.getState(`missing-${randomUUID().slice(0, 8)}`)).toBeNull();
    const badKey = `bad-${randomUUID().slice(0, 8)}`;
    await redis.set(`ai:breaker:test:${badKey}`, '{not-json');
    expect(await storage.getState(badKey)).toBeNull();
  });

  it('滑动窗口 RPM：max=2 时第三次拒绝且携带 Retry-After；超限不计数', async () => {
    const limiter = createSlidingWindowLimiter(redis);
    const dim = `test-rpm-${randomUUID().slice(0, 8)}`;
    expect((await limiter.check(dim, 2, randomUUID())).allowed).toBe(true);
    expect((await limiter.check(dim, 2, randomUUID())).allowed).toBe(true);
    const denied = await limiter.check(dim, 2, randomUUID());
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec ?? 0).toBeGreaterThan(0);
  });

  it('TPM 预占/释放：预占占满后拒绝；释放后可再预占', async () => {
    const limiter = createSlidingWindowLimiter(redis);
    const dim = `test-tpm-${randomUUID().slice(0, 8)}`;
    const requestId = randomUUID();
    expect((await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 60, max: 100 }], requestId)).allowed).toBe(true);
    expect((await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 50, max: 100 }], randomUUID())).allowed).toBe(false); // 60+50 > 100
    await limiter.releaseTpm(requestId);
    expect((await limiter.reserveTpmAll([{ dimension: dim, estimatedTokens: 50, max: 100 }], randomUUID())).allowed).toBe(true);
  });

  it('Key 爆破防护：阈值失败 → 锁定；成功清零', async () => {
    const guard = createKeyBruteForceGuard(redis, { failureThreshold: 2, failureWindowS: 60, lockS: 60 });
    const keyHash = `hash-${randomUUID().slice(0, 8)}`;
    expect((await guard.recordFailure(keyHash)).locked).toBe(false);
    expect((await guard.recordFailure(keyHash)).locked).toBe(true);
    expect((await guard.isLocked(keyHash)).locked).toBe(true);
    await guard.recordSuccess(keyHash);
    expect((await guard.isLocked(keyHash)).locked).toBe(false);
  });
});
