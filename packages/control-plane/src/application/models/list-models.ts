/**
 * 模型映射列表：基础行 + 绑定回显（仅当前页映射一次批量查；未绑定 = []）。
 * view 缺省 = 在册（含上/下架，不含已删除）；view='deleted' = 回收站（仅已删除）。
 */
import type { Db } from '@tillgate/db';
import type {
  ModelStore,
  ModelRecord,
  ModelSortField,
  ModelListView,
} from '../../ports/model-store';

export interface ListModelsDeps {
  readonly db: Db;
  readonly stores: { readonly model: ModelStore };
}

/** 绑定回显行（渠道 + 出站名 + 成本覆盖；null 成本 = 继承映射官方价） */
export interface ModelChannelBinding {
  readonly channelId: number;
  readonly upstreamModel: string;
  readonly costInputPrice: string | null;
  readonly costOutputPrice: string | null;
  readonly costCacheInputPrice: string | null;
  readonly costCacheWritePrice: string | null;
  readonly costUnitPrice: string | null;
  readonly costConfig: Record<string, unknown>;
}

export interface ModelListItem extends ModelRecord {
  readonly channels: ModelChannelBinding[];
}

export interface ListModelsResult {
  readonly rows: ModelListItem[];
  readonly total: number;
}

export interface ListModelsQuery {
  readonly q?: string;
  readonly sortBy: ModelSortField;
  readonly order: 'asc' | 'desc';
  readonly limit: number;
  readonly offset: number;
  /** 列表视图：缺省 active；deleted = 回收站 */
  readonly view?: ModelListView;
}

export async function listModels(
  deps: ListModelsDeps,
  query: ListModelsQuery,
): Promise<ListModelsResult> {
  const result = await deps.stores.model.listMappings(deps.db, query);
  const bindings = await deps.stores.model.listBindingsByMappingIds(
    deps.db,
    result.rows.map((row) => row.id),
  );
  const byMapping = new Map<number, ModelChannelBinding[]>();
  for (const binding of bindings) {
    const list = byMapping.get(binding.mappingId) ?? [];
    list.push({
      channelId: binding.channelId,
      upstreamModel: binding.upstreamModel,
      costInputPrice: binding.costInputPrice,
      costOutputPrice: binding.costOutputPrice,
      costCacheInputPrice: binding.costCacheInputPrice,
      costCacheWritePrice: binding.costCacheWritePrice,
      costUnitPrice: binding.costUnitPrice,
      costConfig: binding.costConfig,
    });
    byMapping.set(binding.mappingId, list);
  }
  return {
    rows: result.rows.map((row) => ({ ...row, channels: byMapping.get(row.id) ?? [] })),
    total: result.total,
  };
}
