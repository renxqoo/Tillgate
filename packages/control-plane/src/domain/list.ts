/**
 * 列表查询形状（管理面统一列表契约）。
 * 排序字段词表由各单元的 store port 收敛（白名单 + id 决胜——分页无跳无重）；
 * page/pageSize 的换算属 app 路由层，包内只收 limit/offset。
 */
export type SortOrder = 'asc' | 'desc';

export interface ListQuery<S extends string> {
  /** 字面搜索（ilike 转义在适配器——搜索无语法，%/_ 按字面匹配） */
  readonly q?: string;
  readonly sortBy: S;
  readonly order: SortOrder;
  readonly limit: number;
  readonly offset: number;
}

export interface ListResult<Row> {
  readonly rows: readonly Row[];
  readonly total: number;
}
