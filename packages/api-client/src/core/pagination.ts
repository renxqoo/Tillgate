/**
 * 统一分页信封与列表查询构造:
 *   - 所有记录列表接口统一 ?page=&limit=
 *   - 默认不传 sort_by → 后端按各表 fallback(通常 created_at desc)排序
 * 框架无关纯函数;错误降级展示归页面层。
 */

/** 统一分页 envelope({rows,total,page,limit},配套 ?page=&limit= 查询参数) */
export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  limit: number;
}

export interface ListFetchOptions {
  page?: number;
  pageSize: number;
  /** 用户点击表头排序时才传;后端白名单校验,非法 400 */
  sortBy?: string;
  order?: 'asc' | 'desc';
  /** 其余筛选参数(值为 undefined / '' 时跳过;数字 0 保留) */
  extra?: Record<string, string | number | undefined>;
}

/** 构造列表查询串:page/limit 必出,sort_by+order 成对,extra 跳过空值 */
export function buildListQuery(opts: ListFetchOptions): string {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    limit: String(opts.pageSize),
  });
  if (opts.sortBy) {
    query.set('sort_by', opts.sortBy);
    query.set('order', opts.order ?? 'desc');
  }
  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (value === undefined || value === '') continue;
    query.set(key, String(value));
  }
  return query.toString();
}
