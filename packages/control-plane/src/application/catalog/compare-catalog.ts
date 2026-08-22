/**
 * 目录拉取比对：三态 diff（±5% 带宽）+ fx 快照 + 预填换算 + 消失检测。
 * comparison 载荷与提交表单共用（UI 双币展示与预填同源）。
 * 源不可达要可读可排障——unavailable + 源名 + 底层原因直达提示条。
 */
import type { Db } from '@tokenlens/db';
import type { CatalogComparison, CatalogItem } from '../../domain/catalog/catalog';
import { compareCatalog, goneFromCatalog } from '../../domain/catalog/compare';
import { toCny } from '../../domain/catalog/convert';
import type { ChannelStore } from '../../ports/channel-store';
import type { ModelStore } from '../../ports/model-store';
import type { FxState } from '../../domain/fx/fx-rates';
import { controlPlaneErrors } from '../../errors';
import type { FxDeps } from '../fx/fx-shared';
import { fxState } from '../fx/fx-state';
import { fetchSourceModels, getSource, type SourceCacheDeps } from './fetch-source-models';

export interface CompareCatalogDeps extends SourceCacheDeps {
  readonly db: Db;
  readonly stores: {
    readonly model: ModelStore;
    readonly channel: ChannelStore;
  };
  readonly fx: FxDeps;
}

export interface CatalogComparisonPayload {
  readonly source: string;
  readonly kind: 'channel' | 'reference';
  readonly priceCurrency: CatalogItem['currency'];
  readonly fetchedAt: string;
  /** 汇率状态（effectiveRate null = 不可用：只展示目录原价，不预填） */
  readonly fx: FxState;
  readonly channelReady: boolean;
  readonly channelRpmLimit: number | null;
  readonly items: Array<
    CatalogComparison & { prefillInputCny: string | null; prefillOutputCny: string | null }
  >;
  /** channel 源专属：绑定到本源渠道但目录已无的映射（复核下架用） */
  readonly gone: Array<{ mappingId: number; externalName: string; realModel: string }>;
}

export async function compareCatalogFromSource(
  deps: CompareCatalogDeps,
  sourceId: string,
): Promise<CatalogComparisonPayload> {
  const source = getSource(deps, sourceId);
  let fetched: { fetchedAt: number; raw: unknown };
  try {
    fetched = await fetchSourceModels(deps, source);
  } catch (error) {
    // 源不可达要可读可排障——不包成 internal error，unavailable + 源名 + 底层原因
    throw controlPlaneErrors.business('catalog_source_unreachable', {
      source: source.name,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const items = source.mapModels(fetched.raw);
  const fxStateNow = await fxState(deps.fx);
  const existing = await deps.stores.model.listEnabledByRealModels(
    deps.db,
    items.map((i) => i.realModel),
  );
  const compared = compareCatalog(
    items,
    existing.map((e) => ({
      externalName: e.externalName,
      realModel: e.realModel,
      inputPrice: e.inputPrice,
      outputPrice: e.outputPrice,
    })),
    { effectiveRate: fxStateNow.effectiveRate },
  ).map((item) => ({
    ...item,
    prefillInputCny: toCny(item.catalogPrompt, item.currency, fxStateNow.effectiveRate),
    prefillOutputCny: toCny(item.catalogCompletion, item.currency, fxStateNow.effectiveRate),
  }));

  let channelReady = false;
  let channelRpmLimit: number | null = null;
  let gone: CatalogComparisonPayload['gone'] = [];
  if (source.channel) {
    const channelRow = await deps.stores.channel.findChannelByName(
      deps.db,
      source.channel.channelName,
    );
    channelReady = channelRow != null;
    channelRpmLimit = channelRow?.rpmLimit ?? null;
    if (channelRow != null) {
      const realModels = new Set(items.map((i) => i.realModel));
      gone = goneFromCatalog(
        await deps.stores.model.listMappingRowsByChannelId(deps.db, channelRow.id),
        realModels,
      );
    }
  }
  return {
    source: source.id,
    kind: source.kind,
    priceCurrency: source.priceCurrency,
    fetchedAt: new Date(fetched.fetchedAt).toISOString(),
    fx: fxStateNow,
    channelReady,
    channelRpmLimit,
    items: compared,
    gone,
  };
}
