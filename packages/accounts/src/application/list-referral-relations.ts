/**
 * 推荐关系列表(管理面;只出关系事实,commission_total 归 billing/app 组合)。
 */
import type { PageResult, RelationView } from '../ports/account-store.js';
import { clampListQuery } from './list-query.js';
import type { UseCaseContext } from './context.js';

export function listReferralRelations(
  ctx: UseCaseContext,
  input: { q?: string; page?: number; limit?: number },
): Promise<PageResult<RelationView>> {
  return ctx.store.listReferralRelations(ctx.db, {
    q: input.q?.trim() || undefined,
    ...clampListQuery(ctx.policy, input.page, input.limit),
  });
}
