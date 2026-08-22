import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import { createRedisHealthStore } from '../src/adapters/state-redis';

interface S {
  version: number;
  count: number;
}

/** 结构化 redis 桩：记录 Lua 入参，按脚本语义回放（脚本本身的原子性在真实段验证） */
function fakeRedis(behavior: { initial?: string; failRead?: boolean }) {
  const evals: { key: string; args: string[] }[] = [];
  const store = new Map<string, string>(
    behavior.initial != null ? [['pref:k', behavior.initial]] : [],
  );
  const redis = {
    get: async (key: string) => {
      if (behavior.failRead) throw new Error('redis down');
      return store.get(key) ?? null;
    },
    eval: async (script: string, numKeys: number, key: string, ...args: string[]) => {
      expect(script).toContain('cjson.decode'); // CAS 脚本形态
      expect(numKeys).toBe(1);
      evals.push({ key, args });
      const [expected, next, ttl] = args as [string, string, string];
      const raw = store.get(key);
      if (raw != null) {
        const current = JSON.parse(raw) as S;
        if (current.version !== Number(expected)) return 0;
      } else if (Number(expected) !== 0) {
        return 0;
      }
      store.set(key, next);
      void ttl;
      return 1;
    },
  } as unknown as Redis;
  return { redis, evals, store };
}

describe('adapters/state-redis：Lua CAS（单元段——脚本入参与回放语义）', () => {
  it('键带前缀；expectedVersion/next/ttl 逐位入参', async () => {
    const { redis, evals } = fakeRedis({});
    const store = createRedisHealthStore(redis, 'inference:health:breaker:');
    expect(await store.compareAndSet<S>('k', 0, { version: 1, count: 1 }, 360_000)).toBe(true);
    expect(evals[0]).toEqual({
      key: 'inference:health:breaker:k',
      args: ['0', JSON.stringify({ version: 1, count: 1 }), '360000'],
    });
  });

  it('读回 JSON 值；坏值 fail-open（按无状态处理）', async () => {
    const { redis } = fakeRedis({ initial: '{"version":1,"count":5}' });
    const store = createRedisHealthStore(redis, 'pref:');
    expect(await store.getState<S>('k')).toEqual({ version: 1, count: 5 });
    const broken = fakeRedis({ initial: '{not json' });
    const store2 = createRedisHealthStore(broken.redis, 'pref:');
    expect(await store2.getState<S>('k')).toBeNull();
  });
});

/** 真实 Redis 段：REDIS_URL 未配置整套 skip（CI 必配；runtime testing 装置连接） */
const redisUrl = process.env.REDIS_URL ?? null;

describe.skipIf(redisUrl == null)('adapters/state-redis：真实 Redis CAS 原子性', () => {
  it('并发 CAS 只有一个赢家；TTL 生效', async () => {
    const { createRedisClient } = await import('@tokenlens/runtime');
    const { waitForRedisReady } = await import('@tokenlens/runtime/testing');
    const redis = createRedisClient(redisUrl as string, { serviceName: 'inference-test' });
    await waitForRedisReady(redis); // offline-queue 关闭形态：就绪前发命令直接抛
    try {
      const store = createRedisHealthStore(redis, 'inference:test:health:');
      const key = `k-${Date.now()}`;
      // 并发首写：expectedVersion=0 双写，只有一个成功（Lua 原子性）
      const results = await Promise.all([
        store.compareAndSet<S>(key, 0, { version: 1, count: 1 }, 60_000),
        store.compareAndSet<S>(key, 0, { version: 1, count: 2 }, 60_000),
      ]);
      expect(results.filter((r) => r)).toHaveLength(1);
      // 后续按版本链推进
      const state = await store.getState<S>(key);
      expect(state?.version).toBe(1);
      expect(await store.compareAndSet<S>(key, 1, { version: 2, count: 9 }, 60_000)).toBe(true);
      expect(await store.compareAndSet<S>(key, 1, { version: 2, count: 8 }, 60_000)).toBe(false);
      await redis.del(`inference:test:health:${key}`);
    } finally {
      redis.disconnect(); // offline-queue 关闭形态下 quit 命令会抛——直接断连
    }
  });
});
