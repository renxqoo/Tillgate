/**
 * 目录源清单（前端 Tab）：源注册表由装配注入（新增源 = 注册一个 adapter）。
 */
import type { CatalogSource } from '../../ports/catalog-source';

export interface CatalogSourceInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: 'channel' | 'reference';
  readonly priceCurrency: 'USD' | 'CNY';
  readonly needsKey: boolean;
  readonly channelName: string | null;
}

export function listCatalogSources(sources: readonly CatalogSource[]): CatalogSourceInfo[] {
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    priceCurrency: s.priceCurrency,
    needsKey: s.channel?.needsKey === true,
    channelName: s.channel?.channelName ?? null,
  }));
}
