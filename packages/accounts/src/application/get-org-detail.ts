/**
 * 组织详情(v1 orgDetail):active 成员可看成员列表;待接受邀请仅 owner 可见且
 **永不包含 token**。
 */
import { AccountsErrors } from '../domain/errors.js';
import type { InvitationRecord, MemberView, OrgRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export interface OrgDetail {
  readonly org: OrgRecord;
  readonly members: readonly MemberView[];
  readonly invitations: readonly InvitationRecord[];
}

export async function getOrgDetail(
  ctx: UseCaseContext,
  input: { userId: number; orgId: number },
): Promise<OrgDetail> {
  const membership = await ctx.store.findActiveMembership(ctx.db, input);
  if (membership === null) throw AccountsErrors.business('org_not_found', { orgId: input.orgId });
  const org = await ctx.store.findOrg(ctx.db, input.orgId);
  if (org === null) throw AccountsErrors.business('org_not_found', { orgId: input.orgId });

  const members = await ctx.store.listMembers(ctx.db, input.orgId);
  const invitations =
    membership.role === 'owner' ? await ctx.store.listPendingInvitations(ctx.db, input.orgId) : [];
  return { org, members, invitations };
}
