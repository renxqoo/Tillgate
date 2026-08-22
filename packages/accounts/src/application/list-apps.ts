/** 属主 App 列表(投影结构性无 clientSecretHash) */
import type { AppRecord, PageResult } from '../ports/account-store.js';
import { clampListQuery } from './list-query.js';
import type { UseCaseContext } from './context.js';

export function listApps(
  ctx: UseCaseContext,
  input: { userId: number; page?: number; limit?: number },
): Promise<PageResult<AppRecord>> {
  return ctx.store.listAppsByUser(ctx.db, {
    userId: input.userId,
    ...clampListQuery(ctx.policy, input.page, input.limit),
  });
}
