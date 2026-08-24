/** 撤销邀请:owner-only;CAS pending→revoked(0 行 → invitation_invalid) */
import { AccountsErrors } from '../domain/errors.js';
import { requireOwnerMembership } from './org-guards.js';
import type { UseCaseContext } from './context.js';

export async function revokeInvitation(
  ctx: UseCaseContext,
  input: { orgId: number; operatorUserId: number; invitationId: number },
): Promise<void> {
  await requireOwnerMembership(ctx, { orgId: input.orgId, userId: input.operatorUserId });
  const ok = await ctx.store.revokeInvitation(ctx.db, {
    orgId: input.orgId,
    invitationId: input.invitationId,
  });
  if (!ok) {
    throw AccountsErrors.business('invitation_invalid', { invitationId: input.invitationId });
  }
}
