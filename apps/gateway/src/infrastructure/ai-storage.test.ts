import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import {
  createRedisBreakerStorage,
  createRedisDeadCredentialStorage,
} from './ai-storage.js';
import type { BreakerState, DeadCredentialState } from '@ai-gateway/ai';

/**
 * Redis 存储实现集成测试：需要真实 Redis（CI 环境）。
 * 本地无 Redis / 认证失败时自动 skip，不阻塞开发。
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

let redis: Redis;
let connected = false;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { retryStrategy: () => null, lazyConnect: true });
  try {
    await redis.connect();
    connected = true;
  } catch {
    connected = false;
  }
});

afterAll(async () => {
  if (redis) await redis.quit().catch(() => {});
});

const itWithRedis = connected ? it : it.skip;

describe('RedisKvStorage（BreakerStorage 实现）', () => {
  itWithRedis('compareAndSet：version 匹配才写入', async () => {
    const storage = createRedisBreakerStorage(redis);
    const key = 'test-cas-' + Date.now();
    const s1: BreakerState = {
      state: 'closed',
      failures: [],
      windowStart: 0,
      version: 1,
    };
    // key 不存在 → expectedVersion=0 可写入
    expect(await storage.compareAndSet(key, 0, s1, 60_000)).toBe(true);
    // version 不匹配 → 失败
    expect(await storage.compareAndSet(key, 0, { ...s1, version: 2 }, 60_000)).toBe(false);
    // version 匹配 → 成功
    expect(await storage.compareAndSet(key, 1, { ...s1, state: 'open', version: 2 }, 60_000)).toBe(true);
    const got = await storage.getState(key);
    expect(got?.state).toBe('open');
    expect(got?.version).toBe(2);
    await redis.del('ai:breaker:' + key);
  });

  itWithRedis('getState：缺失返回 null', async () => {
    const storage = createRedisBreakerStorage(redis);
    expect(await storage.getState('nonexistent-' + Date.now())).toBeNull();
  });

  itWithRedis('setState：无条件写入', async () => {
    const storage = createRedisBreakerStorage(redis);
    const key = 'test-set-' + Date.now();
    const s: BreakerState = { state: 'open', failures: [], windowStart: 0, version: 5 };
    await storage.setState(key, s, 60_000);
    const got = await storage.getState(key);
    expect(got?.version).toBe(5);
    await redis.del('ai:breaker:' + key);
  });
});

describe('RedisKvStorage（DeadCredentialStorage 实现）', () => {
  itWithRedis('compareAndSet：死凭据状态 CAS', async () => {
    const storage = createRedisDeadCredentialStorage(redis);
    const key = 'test-dc-' + Date.now();
    const s: DeadCredentialState = { status: 'valid', consecutiveFailures: 1, version: 1 };
    expect(await storage.compareAndSet(key, 0, s, 60_000)).toBe(true);
    expect(await storage.compareAndSet(key, 1, { ...s, status: 'invalid', version: 2 }, 60_000)).toBe(true);
    const got = await storage.getState(key);
    expect(got?.status).toBe('invalid');
    await redis.del('ai:credential:' + key);
  });

  itWithRedis('breaker 与 credential key 空间隔离', async () => {
    const breaker = createRedisBreakerStorage(redis);
    const cred = createRedisDeadCredentialStorage(redis);
    const key = 'test-isolation-' + Date.now();
    await breaker.setState(key, { state: 'closed', failures: [], windowStart: 0, version: 1 }, 60_000);
    // 同名 key 在不同存储互不影响
    expect(await cred.getState(key)).toBeNull();
    await redis.del('ai:breaker:' + key);
  });
});
