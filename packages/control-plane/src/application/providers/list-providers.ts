/**
 * 供应商列表：q 命中 name/baseUrl（字面匹配）；白名单排序 + id 决胜（分页无跳无重）。
 * view 缺省 = 在册（含启用/禁用，不含已删除）；view='deleted' = 回收站（仅已删除）。
 * page/pageSize 换算属 app 路由层——包内只收 limit/offset。
 */
import type { Db } from '@tokenlens/db';
import type { ProviderStore, ProviderRecord, ProviderListQuery } from '../../ports/provider-store';
import type { ListResult } from '../../domain/list';

export interface ListProvidersDeps {
  readonly db: Db;
  readonly stores: { readonly provider: ProviderStore };
}

export function listProviders(
  deps: ListProvidersDeps,
  query: ProviderListQuery,
): Promise<ListResult<ProviderRecord>> {
  return deps.stores.provider.list(deps.db, query);
}
