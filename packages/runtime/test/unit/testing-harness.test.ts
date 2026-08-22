/** testing 装置自测（mock，无真实 Redis）：URL 判据 + 冷连接轮询语义。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  connectTestRedis,
  disconnectTestRedis,
  testRedisUrl,
  waitForRedisReady,
} from '../../src/testing';

const ORIG = process.env.REDIS_URL;
afterEach(() => {
  if (ORIG === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIG;
  vi.restoreAllMocks();
});

describe('testRedisUrl（skipIf 判据）', () => {
  it('REDIS_URL 未设置 / 空串 → undefined', () => {
    delete process.env.REDIS_URL;
    expect(testRedisUrl()).toBeUndefined();
    process.env.REDIS_URL = '';
    expect(testRedisUrl()).toBeUndefined();
  });

  it('REDIS_URL 非空 → 原值返回', () => {
    process.env.REDIS_URL = 'redis://localhost:6379/1';
    expect(testRedisUrl()).toBe('redis://localhost:6379/1');
  });
});

describe('waitForRedisReady（冷连接轮询）', () => {
  it('ping PONG → true', async () => {
    const redis = { ping: async () => 'PONG' } as unknown as Redis;
    await expect(waitForRedisReady(redis, 200)).resolves.toBe(true);
  });

  it('持续失败 → 超时返回 false（不抛错）', async () => {
    const redis = { ping: async () => Promise.reject(new Error('offline')) } as unknown as Redis;
    await expect(waitForRedisReady(redis, 150)).resolves.toBe(false);
  });
});

describe('connectTestRedis / disconnectTestRedis', () => {
  it('REDIS_URL 未配置 → null（用方整套跳过）；null 断开为 no-op', async () => {
    delete process.env.REDIS_URL;
    await expect(connectTestRedis()).resolves.toBeNull();
    await expect(disconnectTestRedis(null)).resolves.toBeUndefined();
  });
});
