/**
 * 列表页 URL 参数工具（server / client 通用纯函数）。
 *
 * 统一约定（与 @ai-gateway/http list-query 对应）：
 *   - 分页 ?page=&page_size=
 *   - 搜索 ?q=
 *   - 排序 ?sort_by=&order=asc|desc（默认 created_at desc）
 * 翻页/排序/筛选全部走 URL 参数（GET 可分享、可刷新），组件无本地状态。
 */

export type SearchParamsInput = Record<string, string | string[] | undefined>;

/**
 * 构建列表页 href：保留现有筛选参数，应用 overrides。
 * overrides 中 undefined / null / '' 表示删除该参数（翻页保留筛选、清空搜索等都靠它）。
 */
export function listHref(
  searchParams: SearchParamsInput,
  overrides?: Record<string, string | number | undefined | null>,
): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) sp.append(key, v);
    } else {
      sp.set(key, value);
    }
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === null || value === '') sp.delete(key);
      else sp.set(key, String(value));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/** Next searchParams 单值读取：数组取第一个，空串视为未传 */
export function firstParam(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === '' ? undefined : v;
}

export interface ListSearchParamsResult {
  /** 搜索词（默认 ""） */
  q: string;
  /** 页码（>=1，默认 1） */
  page: number;
  /** 排序字段（未传为 undefined → 后端按 fallback 排序） */
  sortBy?: string;
  /** 排序方向（默认 desc） */
  order: 'asc' | 'desc';
}

/**
 * 列表页 searchParams 统一解析（收敛 21 处 page.tsx 顶部样板）：
 *
 *   const sp = await searchParams;
 *   const q = firstParam(sp.q) ?? "";
 *   const page = Math.max(1, Number(firstParam(sp.page) ?? "1") || 1);
 *   const sortBy = firstParam(sp.sort_by);
 *   const order = firstParam(sp.order) === "asc" ? "asc" : "desc";
 *
 * 用法：`const { q, page, sortBy, order } = parseListSearchParams(await searchParams);`
 */
export function parseListSearchParams(sp: SearchParamsInput): ListSearchParamsResult {
  return {
    q: firstParam(sp.q) ?? '',
    page: Math.max(1, Number(firstParam(sp.page) ?? '1') || 1),
    sortBy: firstParam(sp.sort_by),
    order: firstParam(sp.order) === 'asc' ? 'asc' : 'desc',
  };
}
