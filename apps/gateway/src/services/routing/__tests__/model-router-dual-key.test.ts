import { describe, expect, it, vi } from 'vitest';
import { ModelRouter } from '../model-router.js';
import { decrypt, encrypt } from '@ai-gateway/core';
import type { Db } from '@ai-gateway/db';

const KEY_V1 = 'old-encryption-key-32-chars-minimum!!';
const KEY_V2 = 'new-encryption-key-32-chars-minimum!!';

/**
 * A6 回归锁定（R6 加密轮换双 key 窗）：model-router 渠道解密接线。
 *   - v1 密文 + ENCRYPTION_KEY_OLD → 解出明文（轮换窗内服务不中断）
 *   - v2 密文 → 当前 key 解
 *   - v1 密文但未设 OLD（收窗后遗留/配错）→ 解密失败（GCM 认证，不静默错值）
 */

function makeMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: vi.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve('OK');
    }),
    incr: vi.fn(() => Promise.resolve(1)),
    del: vi.fn((k: string) => {
      store.delete(k);
      return Promise.resolve(1);
    }),
  };
}

function makeMockDb(channelRows: unknown[]) {
  return {
    query: {
      modelMappings: { findFirst: vi.fn().mockResolvedValue(null) },
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
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  } as unknown as Db;
}

function channelRow(apiKeyEnc: string) {
  return {
    channelId: 1,
    channelName: 'ch1',
    providerName: 'prov1',
    providerBaseUrl: 'https://upstream.example',
    providerProtocol: 'openai',
    apiKeyEnc,
    baseUrlOverride: null,
    weight: 1,
    rpmLimit: null,
    tpmLimit: null,
  };
}

describe('model-router 双 key 解密（A6）', () => {
  it('v1 密文 + OLD → 明文；v2 密文 → 当前 key；v1 无 OLD → 抛错', async () => {
    const legacy = encrypt('upstream-secret-legacy', KEY_V1); // enc:v1
    const fresh = encrypt('upstream-secret-fresh', KEY_V2, 2); // enc:v2

    // 窗口期：NEW + OLD
    const windowRouter = new ModelRouter(makeMockDb([channelRow(legacy), channelRow(fresh)]) as never, makeMockRedis() as never, KEY_V2, KEY_V1);
    const channels = await windowRouter.getChannels('some-real-model');
    expect(channels.map((c) => c.apiKey).toSorted()).toEqual(['upstream-secret-fresh', 'upstream-secret-legacy']);

    // 收窗后（无 OLD）：v2 可解
    const closedRouter = new ModelRouter(makeMockDb([channelRow(fresh)]) as never, makeMockRedis() as never, KEY_V2);
    const closed = await closedRouter.getChannels('some-real-model');
    expect(closed[0]!.apiKey).toBe('upstream-secret-fresh');

    // 收窗后遗留 v1 行 → GCM 认证失败（绝不解出垃圾明文）
    const staleRouter = new ModelRouter(makeMockDb([channelRow(legacy)]) as never, makeMockRedis() as never, KEY_V2);
    await expect(staleRouter.getChannels('some-real-model')).rejects.toThrow();
    // 信封语义自证：v1 行在无 OLD 时用当前 key 解必然认证失败
    expect(() => decrypt(legacy, KEY_V2)).toThrow();
  });
});
