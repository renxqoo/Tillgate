/**
 * 目录源缓存 port：拉取结果的进程内 TTL 货架（目录是临时货架，不落库）。
 * 默认内存实现；未来多副本共享缓存时换 redis 实现（接口不变）。
 */

export interface CatalogCacheEntry {
  readonly fetchedAt: number;
  readonly raw: unknown;
}

export interface CatalogCache {
  get(sourceId: string): CatalogCacheEntry | undefined;
  set(sourceId: string, entry: CatalogCacheEntry): void;
}

/** 进程内实现（Map 无上限——源 id 由装配收敛为有限词表，不构成泄漏面） */
export function createMemoryCatalogCache(): CatalogCache {
  const store = new Map<string, CatalogCacheEntry>();
  return {
    get: (sourceId) => store.get(sourceId),
    set: (sourceId, entry) => {
      store.set(sourceId, entry);
    },
  };
}
