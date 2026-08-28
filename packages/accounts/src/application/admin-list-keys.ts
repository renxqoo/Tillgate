/** 管理面 Key 列表:q 命中 name/preview/属主邮箱/属主昵称 + 过滤分页 */
import type { ApiKeyRecord, PageResult } from '../ports/account-store.js';
import { KEY_SORT_FIELDS, clampListQuery, resolveSort } from './list-query.js';
import type { UseCaseContext } from './context.js';

export interface AdminListKeysInput {
  readonly q?: string;
  readonly userId?: number;
  readonly status?: number;
  readonly sort?: string;
  readonly order?: 'asc' | 'desc';
  readonly page?: number;
  readonly limit?: number;
}

export function adminListKeys(
  ctx: UseCaseContext,
  input: AdminListKeysInput,
): Promise<PageResult<ApiKeyRecord>> {
  return ctx.store.listAdminKeys(ctx.db, {
    q: input.q?.trim() || undefined,
    userId: input.userId,
    status: input.status,
    sort: resolveSort(KEY_SORT_FIELDS, input.sort, input.order),
    ...clampListQuery(ctx.policy, input.page, input.limit),
  });
}
