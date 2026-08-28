/**
 * 列表查询公共件:分页钳制与排序白名单解析。
 * 排序字段是封闭词表;实现契约:任意排序附 desc(id) 稳定 tiebreaker。
 */
import type { ListQuery, SortSpec } from '../ports/account-store.js';
import type { AccountsPolicy } from './context.js';

export function clampListQuery(policy: AccountsPolicy, page?: number, limit?: number): ListQuery {
  const p =
    page !== undefined && Number.isSafeInteger(page) && page >= 1 ? page : policy.listPage.page;
  const l =
    limit !== undefined && Number.isSafeInteger(limit) && limit >= 1
      ? Math.min(limit, policy.listPage.maxLimit)
      : policy.listPage.limit;
  return { page: p, limit: l };
}

export const USER_SORT_FIELDS = ['id', 'subject', 'createdAt', 'lastLoginAt'] as const;
export const KEY_SORT_FIELDS = ['id', 'name', 'status', 'lastUsedAt', 'createdAt'] as const;

export type SortFieldInput = readonly string[];

export function resolveSort(
  allowed: SortFieldInput,
  field?: string,
  order?: 'asc' | 'desc',
): SortSpec {
  // 词表为空时 allowed[0] 会静默变成 undefined 落进 ORDER BY——装配期契约在此 fail-fast
  const [fallback] = allowed;
  if (fallback === undefined) {
    throw new Error('resolveSort requires a non-empty sort field whitelist');
  }
  const chosen = field !== undefined && allowed.includes(field) ? field : fallback;
  return { field: chosen, order: order === 'asc' ? 'asc' : 'desc' };
}
