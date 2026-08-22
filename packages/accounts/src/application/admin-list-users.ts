/** 管理面用户列表:q 模糊(subject/email/displayName)+ status/enterprise 过滤 + 排序分页(v1 listAdminUsers) */
import type { PageResult, UserRecord } from '../ports/account-store.js';
import { USER_SORT_FIELDS, clampListQuery, resolveSort } from './list-query.js';
import type { UseCaseContext } from './context.js';

export interface AdminListUsersInput {
  readonly q?: string;
  readonly status?: number;
  readonly enterprise?: boolean;
  readonly sort?: string;
  readonly order?: 'asc' | 'desc';
  readonly page?: number;
  readonly limit?: number;
}

export async function adminListUsers(ctx: UseCaseContext, input: AdminListUsersInput): Promise<PageResult<UserRecord>> {
  return ctx.store.listUsers(ctx.db, {
    q: input.q?.trim() || undefined,
    status: input.status,
    enterprise: input.enterprise,
    sort: resolveSort(USER_SORT_FIELDS, input.sort, input.order),
    ...clampListQuery(ctx.policy, input.page, input.limit),
  });
}
