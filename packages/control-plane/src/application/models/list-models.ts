/**
 * 模型映射列表：基础行 + channelIds 回显（仅当前页映射一次批量查；未绑定 = []）。
 */
import type { Db } from '@tokenlens/db';
import type { ModelStore, ModelRecord, ModelSortField } from '../../ports/model-store';
import type { ListQuery } from '../../domain/list';

export interface ListModelsDeps {
  readonly db: Db;
  readonly stores: { readonly model: ModelStore };
}

export interface ModelListItem extends ModelRecord {
  readonly channelIds: number[];
}

export interface ListModelsResult {
  readonly rows: ModelListItem[];
  readonly total: number;
}

export async function listModels(
  deps: ListModelsDeps,
  query: ListQuery<ModelSortField>,
): Promise<ListModelsResult> {
  const result = await deps.stores.model.listMappings(deps.db, query);
  const bindings = await deps.stores.model.listChannelIdsByMappingIds(
    deps.db,
    result.rows.map((row) => row.id),
  );
  const byMapping = new Map<number, number[]>();
  for (const binding of bindings) {
    const list = byMapping.get(binding.mappingId) ?? [];
    list.push(binding.channelId);
    byMapping.set(binding.mappingId, list);
  }
  return {
    rows: result.rows.map((row) => ({ ...row, channelIds: byMapping.get(row.id) ?? [] })),
    total: result.total,
  };
}
