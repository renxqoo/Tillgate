import { describe, expect, it, vi } from 'vitest';
import { KeyAuthCache, KEY_AUTH_TTL_S, type CachedKeyAuth } from './key-auth-cache.js';

/**
 * 鉴权 Redis 缓存（S5）：
 *   - keyHash → {userId, apiKeyId, status, expiresAt, ...} 快照，TTL 60s
 *   - 缓存命中 → 跳过 DB 查询（百万 QPS 下 PG 不再是瓶颈）
 *   - 吊销/禁用 → admin 端 DEL auth:key:{keyHash} 清缓存（或等 TTL 自然过期）
 *   - fail-open：Redis 不可用时降级查 DB（不阻塞鉴权）
 *
 * 用 mock storage 测试（不依赖真实 Redis）。
 */

function makeMockStorage() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async setex(key: string, ttl: number, value: string) {
      store.set(key, value);
    },
    async del(key: string) {
      store.delete(key);
    },
  };
}

const VALID_SNAPSHOT: CachedKeyAuth = {
  userId: 1,
  apiKeyId: 5,
  status: 0,
  rateCardId: 1,
  coefficientMilli: 1000,
  rpmLimit: null,
  tpmLimit: null,
  userStatus: 0,
  userRpmLimit: 60,
  userTpmLimit: 1_000_000,
  cachedAt: Date.now(),
};

describe('KeyAuthCache', () => {
  it('缓存命中 → 返回快照（不查 DB）', async () => {
    const storage = makeMockStorage();
    const cache = new KeyAuthCache(storage as never);
    const loadFromDb = vi.fn().mockResolvedValue(VALID_SNAPSHOT);
    // 第一次：miss → 查 DB + 回填缓存
    await cache.getOrLoad('keyhash-abc', loadFromDb);
    expect(loadFromDb).toHaveBeenCalledOnce();
    // 第二次：命中 → 不查 DB
    const result = await cache.getOrLoad('keyhash-abc', loadFromDb);
    expect(result).toEqual(VALID_SNAPSHOT);
    expect(loadFromDb).toHaveBeenCalledOnce(); // 仍只查一次
  });

  it('缓存未命中 → 查 DB 并写入缓存', async () => {
    const storage = makeMockStorage();
    const cache = new KeyAuthCache(storage as never);
    const loadFromDb = vi.fn().mockResolvedValue(VALID_SNAPSHOT);
    const result = await cache.getOrLoad('keyhash-def', loadFromDb);
    expect(result).toEqual(VALID_SNAPSHOT);
    expect(loadFromDb).toHaveBeenCalledOnce();
    // 第二次应命中缓存（不查 DB）
    await cache.getOrLoad('keyhash-def', loadFromDb);
    expect(loadFromDb).toHaveBeenCalledOnce(); // 仍只查一次
  });

  it('吊销 → DEL 清缓存后下次重新查 DB', async () => {
    const storage = makeMockStorage();
    const cache = new KeyAuthCache(storage as never);
    const loadFromDb = vi.fn().mockResolvedValue(VALID_SNAPSHOT);
    await cache.getOrLoad('keyhash-revoke', loadFromDb);
    expect(loadFromDb).toHaveBeenCalledOnce();
    await cache.invalidate('keyhash-revoke');
    await cache.getOrLoad('keyhash-revoke', loadFromDb);
    expect(loadFromDb).toHaveBeenCalledTimes(2); // 吊销后重新查
  });

  it('DB 查无此 Key → 不写缓存（null 不缓存，防缓存穿透）', async () => {
    const storage = makeMockStorage();
    const cache = new KeyAuthCache(storage as never);
    const loadFromDb = vi.fn().mockResolvedValue(null);
    const result = await cache.getOrLoad('keyhash-none', loadFromDb);
    expect(result).toBeNull();
    expect(storage.store.size).toBe(0); // 未写缓存
  });

  it('快照过期（cachedAt + TTL < now）→ 重新查 DB', async () => {
    const storage = makeMockStorage();
    const cache = new KeyAuthCache(storage as never);
    // 手动写入过期快照
    const expired = { ...VALID_SNAPSHOT, cachedAt: Date.now() - (KEY_AUTH_TTL_S + 10) * 1000 };
    storage.store.set('auth:key:keyhash-expired', JSON.stringify(expired));
    const loadFromDb = vi.fn().mockResolvedValue(VALID_SNAPSHOT);
    await cache.getOrLoad('keyhash-expired', loadFromDb);
    expect(loadFromDb).toHaveBeenCalledOnce(); // 过期 → 重新查
  });

  it('status≠0（已吊销）的快照不缓存有效，下次重新查', async () => {
    const storage = makeMockStorage();
    const cache = new KeyAuthCache(storage as never);
    const revokedSnapshot = { ...VALID_SNAPSHOT, status: 1 };
    const loadFromDb = vi.fn().mockResolvedValue(revokedSnapshot);
    await cache.getOrLoad('keyhash-revoked', loadFromDb);
    // 吊销状态的快照不写缓存（下次仍查 DB 确认最新状态）
    expect(storage.store.size).toBe(0);
  });
});
