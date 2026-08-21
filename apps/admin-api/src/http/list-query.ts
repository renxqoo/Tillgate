/**
 * 统一列表查询解析（统一列表契约）：
 *   - 分页参数永不 400：page ≥1，page_size 1..100 钳制（默认 20）
 *   - q 去空白，1..100 字符（空白 = 不过滤）；ilike 字面匹配在 repository（%/_ 转义）
 *   - sort_by 白名单校验：未知字段 400 invalid_sort_field（不静默回退）
 *   - order ∈ asc|desc（默认 desc）
 */
import { AppError } from './error-map.js';

export interface ListQueryParts {
  q?: string;
  sortBy: string;
  order: 'asc' | 'desc';
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
}

export const PAGE_SIZE_MAX = 100;

export function parseListQuery(
  query: Record<string, string | string[] | undefined>,
  sortWhitelist: readonly string[],
  defaultSort: string,
): ListQueryParts {
  const first = (key: string): string | undefined => {
    const v = query[key];
    return Array.isArray(v) ? v[0] : v;
  };

  const page = Math.max(1, Number.parseInt(first('page') ?? '1', 10) || 1);
  const rawSize = Number.parseInt(first('page_size') ?? '20', 10);
  const pageSize = Number.isFinite(rawSize) && rawSize >= 1 ? Math.min(rawSize, PAGE_SIZE_MAX) : 20;

  const rawQ = (first('q') ?? '').trim();
  const q = rawQ.length === 0 ? undefined : rawQ.slice(0, 100);

  const sortBy = (first('sort_by') ?? '').trim() || defaultSort;
  if (!sortWhitelist.includes(sortBy)) {
    throw new AppError(400, 'invalid_sort_field', `Unsupported sort field (allowed: ${sortWhitelist.join(', ')})`);
  }
  const order = first('order') === 'asc' ? 'asc' : 'desc';

  return { q, sortBy, order, page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
