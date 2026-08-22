/**
 * 目录源拉取（TTL 缓存）与源解析——catalog 用例共享内部
 * （comparison 与 import 用同一份货架快照，预填换算同源）。
 */
import type { CatalogSource } from '../../ports/catalog-source';
import type { CatalogCache } from '../../ports/cache';
import { controlPlaneErrors } from '../../errors';

export interface SourceFetch {
  readonly fetchedAt: number;
  readonly raw: unknown;
}

export interface SourceCacheDeps {
  readonly sources: readonly CatalogSource[];
  readonly cache: CatalogCache;
  /** 目录缓存 TTL（ms，装配注入） */
  readonly cacheTtlMs: number;
}

export async function fetchSourceModels(
  deps: SourceCacheDeps,
  source: CatalogSource,
): Promise<SourceFetch> {
  const cached = deps.cache.get(source.id);
  if (cached && Date.now() - cached.fetchedAt < deps.cacheTtlMs) {
    return { fetchedAt: cached.fetchedAt, raw: cached.raw };
  }
  const raw = await source.fetchModels();
  const entry = { fetchedAt: Date.now(), raw };
  deps.cache.set(source.id, entry);
  return entry;
}

export function getSource(deps: SourceCacheDeps, sourceId: string): CatalogSource {
  const source = deps.sources.find((s) => s.id === sourceId);
  if (!source) {
    throw controlPlaneErrors.business('catalog_source_not_found', { sourceId });
  }
  return source;
}
