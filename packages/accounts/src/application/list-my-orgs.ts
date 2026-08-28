/** 我的组织列表(active 成员资格;订阅富化归 app 组合) */
import type { OrgMembershipView } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export function listMyOrgs(
  ctx: UseCaseContext,
  userId: number,
): Promise<readonly OrgMembershipView[]> {
  return ctx.store.listMembershipsForUser(ctx.db, userId);
}
