/** 属主 Key 列表(v1 listByUser;投影结构性无 keyHash) */
import type { ApiKeyRecord, PageResult } from '../ports/account-store.js';
import { clampListQuery } from './list-query.js';
import type { UseCaseContext } from './context.js';

export function listKeys(
  ctx: UseCaseContext,
  input: { userId: number; page?: number; limit?: number },
): Promise<PageResult<ApiKeyRecord>> {
  return ctx.store.listKeysByUser(ctx.db, {
    userId: input.userId,
    ...clampListQuery(ctx.policy, input.page, input.limit),
  });
}
