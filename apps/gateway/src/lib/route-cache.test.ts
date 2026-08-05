import { describe, expect, it, vi } from 'vitest';
import { getMapping, getChannels, invalidateRouteCache } from './route-cache.js';
import { encrypt } from './crypto.js';
import type { Db } from '@ai-gateway/db';

const TEST_KEY = 'test-encryption-key-32chars-min!!'; // ≥32 字符

/**
 * 路由缓存测试（mock Redis + mock Db）：
 *   - miss → 查 DB → 回填缓存
 *   - 命中缓存 → 不查 DB
 *   - 版本 bump → 旧缓存失效 → 重新查 DB
 *   - 缓存「不存在」结果（防穿透）
 *   - Redis 不可用 → 降级查 DB（正确但慢）
 *
 * 验证消除热路径 DB 查询的核心契约。
 */

/** 构造 mock Redis（内存 Map 模拟） */
function makeMockRedis(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: vi.fn((k: string, v: string, ..._rest: unknown[]) => {
      // 支持 ('EX', ttl) 后缀
      store.set(k, v);
      return Promise.resolve('OK');
    }),
    incr: vi.fn((k: string) => {
      const cur = Number(store.get(k) ?? '0');
      const next = cur + 1;
      store.set(k, String(next));
      return Promise.resolve(next);
    }),
    del: vi.fn((k: string) => {
      store.delete(k);
      return Promise.resolve(1);
    }),
  };
}

function makeMockDb(mappingRow: unknown | null, channelRows: unknown[] = []) {
  return {
    query: {
      modelMappings: {
        findFirst: vi.fn().mockResolvedValue(mappingRow),
      },
    },
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue(channelRows),
              }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db;
}

const SAMPLE_MAPPING = {
  id: 1,
  externalName: 'gpt-4',
  realModel: 'gpt-4-real',
  status: 0,
  inputPrice: 1_000_000,
  outputPrice: 2_000_000,
  cacheInputPrice: 100_000,
  fallbackModels: ['gpt-3.5'],
  paramRules: null,
  rpmLimit: null,
  tpmLimit: null,
};

describe('route-cache 模型映射缓存', () => {
  it('miss → 查 DB → 回填缓存', async () => {
    const redis = makeMockRedis();
    const db = makeMockDb(SAMPLE_MAPPING);
    const r1 = await getMapping(db, redis as never, 'gpt-4');
    expect(r1?.externalName).toBe('gpt-4');
    expect(db.query.modelMappings.findFirst).toHaveBeenCalledTimes(1); // miss 查了 DB
    expect(redis.set).toHaveBeenCalled(); // 回填了

    // 第二次：命中缓存，不查 DB
    const r2 = await getMapping(db, redis as never, 'gpt-4');
    expect(r2?.externalName).toBe('gpt-4');
    expect(db.query.modelMappings.findFirst).toHaveBeenCalledTimes(1); // 仍 1 次（命中未查 DB）
  });

  it('缓存「不存在」结果（防穿透：已下架模型不反复查 DB）', async () => {
    const redis = makeMockRedis();
    const db = makeMockDb(null); // 模型不存在
    const r1 = await getMapping(db, redis as never, 'removed-model');
    expect(r1).toBeNull();
    expect(db.query.modelMappings.findFirst).toHaveBeenCalledTimes(1);

    // 第二次：命中「不存在」缓存，不查 DB
    const r2 = await getMapping(db, redis as never, 'removed-model');
    expect(r2).toBeNull();
    expect(db.query.modelMappings.findFirst).toHaveBeenCalledTimes(1);
  });

  it('版本 bump → 旧缓存失效 → 重新查 DB', async () => {
    const redis = makeMockRedis();
    const db = makeMockDb(SAMPLE_MAPPING);
    // 首次填充
    await getMapping(db, redis as never, 'gpt-4');
    expect(db.query.modelMappings.findFirst).toHaveBeenCalledTimes(1);

    // bump 版本（admin 改了配置）
    await invalidateRouteCache(redis as never);

    // 再次查询：版本变了 → miss → 重新查 DB
    await getMapping(db, redis as never, 'gpt-4');
    expect(db.query.modelMappings.findFirst).toHaveBeenCalledTimes(2);
  });

  it('Redis 不可用 → 降级查 DB（不抛错）', async () => {
    const failingRedis = {
      get: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
      set: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
      incr: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    };
    const db = makeMockDb(SAMPLE_MAPPING);
    // Redis 挂 → 降级查 DB（仍返回正确结果）
    const r = await getMapping(db, failingRedis as never, 'gpt-4');
    expect(r?.externalName).toBe('gpt-4');
    expect(db.query.modelMappings.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('route-cache 渠道解析缓存', () => {
  it('miss → 查 DB → 回填；命中不查 DB', async () => {
    const redis = makeMockRedis();
    const channelRow = {
      channelId: 5,
      channelName: 'test-ch',
      apiKeyEnc: encrypt('sk-upstream-real-key', TEST_KEY),
      baseUrlOverride: 'http://up:8080',
      providerName: 'testprov',
      providerBaseUrl: 'http://default:8080',
      providerProtocol: 'openai_compatible',
      mcWeight: 1,
      mcPriority: 0,
    };
    const db = makeMockDb(null, [channelRow]);
    const r1 = await getChannels(db, redis as never, 'gpt-4-real', TEST_KEY);
    expect(r1).toHaveLength(1);
    expect(r1[0]?.channelId).toBe(5);
    expect(r1[0]?.baseUrl).toBe('http://up:8080');

    // 第二次命中缓存
    const r2 = await getChannels(db, redis as never, 'gpt-4-real', 'testkey');
    expect(r2).toHaveLength(1);
    // db.select 只被调一次（miss 时），命中不再调
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('空渠道列表 → 缓存 EMPTY，防穿透', async () => {
    const redis = makeMockRedis();
    const db = makeMockDb(null, []); // 无渠道
    const r1 = await getChannels(db, redis as never, 'orphan-model', TEST_KEY);
    expect(r1).toEqual([]);
    const r2 = await getChannels(db, redis as never, 'orphan-model', 'testkey');
    expect(r2).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(1); // 第二次命中空缓存
  });
});
