/** 组织守卫(owner 专属动词共用;非成员/非 owner 统一 403 语义) */
import { AccountsErrors } from '../domain/errors.js';
import type { MembershipRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export async function requireOwnerMembership(
  ctx: UseCaseContext,
  input: { orgId: number; userId: number },
): Promise<MembershipRecord> {
  const membership = await ctx.store.findActiveMembership(ctx.db, input);
  if (membership === null || membership.role !== 'owner') {
    throw AccountsErrors.business('org_forbidden', { orgId: input.orgId });
  }
  return membership;
}
