/**
 * 推荐关系列表(管理面;v1 listRelations 去 wallet 化:B3/G3——commission_total
 * 口径修正后归 billing/app 组合,本列表只出关系事实)。
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
