import { describe, expect, it } from 'vitest';
import { ModelRouter } from '../model-router.js';
import { encrypt } from '@ai-gateway/core';
import type { Db } from '@ai-gateway/db';

/**
 * TDD 复现测试 —— 路由缓存把解密后的渠道 Key 明文写进 Redis（中危）。
 *
 * route-cache.ts:73 注释声称「apiKey: 解密后的apiKey（敏感：仅在进程内存，永不日志/返回）」，
 * 但 getChannels 实际把含 apiKey 明文的 JSON 写入 Redis（line 183）。
 * Redis 落盘（appendonly/RDB）/ 共享 / 被攻破 → 上游凭据泄露。
 *
 * 当前应 FAIL：写入 Redis 的 JSON 含明文 apiKey。
 * 修复后应通过：缓存值不含明文 key（例如只缓存 apiKeyEnc，使用时再解密）。
 */

const ENCRYPTION_KEY = 'test-encryption-key-32-chars-min!!';
const PLAINTEXT_KEY = 'sk-upstream-secret-12345';

function makeCaptureRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
      return 'OK';
    },
    async incr(key: string) {
      const v = (Number(store.get(key) ?? '0') || 0) + 1;
      store.set(key, String(v));
      return v;
    },
    async del(key: string) {
      store.delete(key);
      return 1;
    },
  };
}

function makeDbMock(apiKeyEnc: string): Db {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                orderBy: () =>
                  Promise.resolve([
                    {
                      channelId: 1,
                      channelName: 'test-channel',
                      apiKeyEnc,
                      baseUrlOverride: null,
                      providerName: 'openai',
                      providerBaseUrl: 'https://api.openai.com',
                      providerProtocol: 'openai',
                      mcWeight: 100,
                      mcPriority: 1,
                    },
                  ]),
              }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db;
}

describe('路由缓存明文 Key 泄露（修复后只存密文 apiKeyEnc）', () => {
  it('getChannels 写入 Redis 的缓存值只含密文 apiKeyEnc，不含明文 apiKey', async () => {
    const redis = makeCaptureRedis();
    const apiKeyEnc = encrypt(PLAINTEXT_KEY, ENCRYPTION_KEY); // DB 里存的是密文
    const dbMock = makeDbMock(apiKeyEnc);

    const router = new ModelRouter(dbMock, redis as never, ENCRYPTION_KEY);
    const result = await router.getChannels('gpt-4');

    // 内存返回值：含解密明文（供调用方使用）
    expect(result[0]?.apiKey).toBe(PLAINTEXT_KEY);

    // Redis 缓存值：只含密文 apiKeyEnc，不含明文 apiKey 字段、不含明文字面量
    const cacheEntry = [...redis.store.entries()].find(([k]) => k.startsWith('route:channels:'));
    expect(cacheEntry).toBeDefined();
    const cachedJson = cacheEntry![1];
    const parsed = JSON.parse(cachedJson) as Array<Record<string, unknown>>;
    expect(parsed[0]?.apiKeyEnc).toBe(apiKeyEnc); // 密文落 Redis
    expect(parsed[0]?.apiKey).toBeUndefined(); // 明文字段不存在
    expect(cachedJson).not.toContain(PLAINTEXT_KEY); // 明文字面量不出现
  });

  it('从 Redis 读缓存 → 内存解密出明文（缓存命中路径也安全）', async () => {
    const redis = makeCaptureRedis();
    const apiKeyEnc = encrypt(PLAINTEXT_KEY, ENCRYPTION_KEY);
    // 预置 Redis 缓存（密文版）
    redis.store.set(
      'route:channels:v0:gpt-4',
      JSON.stringify([
        {
          channelId: 1,
          baseUrl: 'https://api.openai.com',
          apiKeyEnc,
          protocol: 'openai',
          providerName: 'openai',
          key: 'openai/test',
        },
      ]),
    );
    const dbMock = makeDbMock(apiKeyEnc); // 不应被调用（缓存命中）
    const router = new ModelRouter(dbMock, redis as never, ENCRYPTION_KEY);
    const result = await router.getChannels('gpt-4');
    expect(result[0]?.apiKey).toBe(PLAINTEXT_KEY); // 内存解密出明文
  });

  it('对照组：mapping 缓存不含密钥', async () => {
    const redis = makeCaptureRedis();
    const cachedJson = JSON.stringify([{ id: 1, externalName: 'gpt-4', realModel: 'gpt-4' }]);
    redis.store.set('route:mapping:v0:gpt-4', cachedJson);
    expect(cachedJson).not.toContain(PLAINTEXT_KEY);
  });
});
