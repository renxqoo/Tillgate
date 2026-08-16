import type { SearchParamsInput } from './list-query.js';

/**
 * 分页 href 构造（单一实现，Pager 与测试共用）。
 * 保留现有筛选参数，页码写入 pageKey（单列表页默认 page；同页多列表
 * 必须各用独立键，如用户详情页的 tpage/apage——键名对不上页面读不到，
 * 翻页即无效）。空值参数跳过。
 */
export function pagerHref(
  searchParams: SearchParamsInput,
  pageKey: string,
  targetPage: number,
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
  sp.set(pageKey, String(targetPage));
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}
