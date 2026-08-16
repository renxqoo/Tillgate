/**
 * 列表页统一数据获取（R10，api-contract §4）：
 *   - 所有记录列表接口统一 ?page=&page_size=&q=&sort_by=&order=
 *   - 默认不传 sort_by → 后端按各表 fallback（通常 created_at desc）排序
 *   - 页面骨架（ListPage）+ 表格（DataTable）+ 本模块共同构成统一列表页组件
 */

import { adminFetch, apiFetch, ApiError, type Paginated } from './index';

export interface ListFetchOptions {
  page?: number;
  pageSize: number;
  /** 用户点击表头排序时才传；后端白名单校验，非法 400 */
  sortBy?: string;
  order?: 'asc' | 'desc';
  /** 其余筛选参数（值为 undefined / '' 时跳过） */
  extra?: Record<string, string | number | undefined>;
}

export interface ListFetchResult<T> {
  rows: T[];
  total: number;
  error: string | null;
}

export function buildListQuery(opts: ListFetchOptions): string {
  const query = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize),
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

async function run<T>(fetcher: typeof adminFetch, path: string, opts: ListFetchOptions): Promise<ListFetchResult<T>> {
  try {
    const data = await fetcher<Paginated<T>>(`${path}?${buildListQuery(opts)}`);
    return { rows: data.list ?? [], total: data.total ?? 0, error: null };
  } catch (e) {
    return {
      rows: [],
      total: 0,
      error: e instanceof ApiError ? e.message : '加载失败',
    };
  }
}

/** 管理台列表页数据（adminFetch） */
export function fetchAdminList<T>(path: string, opts: ListFetchOptions): Promise<ListFetchResult<T>> {
  return run(adminFetch, path, opts);
}

/** 用户面板列表页数据（apiFetch） */
export function fetchUserList<T>(path: string, opts: ListFetchOptions): Promise<ListFetchResult<T>> {
  return run(apiFetch, path, opts);
}
