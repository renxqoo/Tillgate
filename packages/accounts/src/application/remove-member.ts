/** 移除成员:owner-only;owner 自身不可移除;CAS active→left(软删) */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import { requireOwnerMembership } from './org-guards.js';
import type { UseCaseContext } from './context.js';

export async function removeMember(
  ctx: UseCaseContext,
  input: { orgId: number; operatorUserId: number; memberUserId: number },
): Promise<void> {
  await requireOwnerMembership(ctx, { orgId: input.orgId, userId: input.operatorUserId });
  if (input.memberUserId === input.operatorUserId) {
    throw AccountsErrors.business('org_cannot_remove_owner', { orgId: input.orgId });
  }
  const ok = await runTx(
    ctx.db,
    (tx) => ctx.store.removeMember(tx, { orgId: input.orgId, userId: input.memberUserId }),
    ctx.txRetry,
  );
  if (!ok) throw AccountsErrors.business('member_not_found', { userId: input.memberUserId });
}
