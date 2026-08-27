/**
 * 邀请成员:owner-only → 有效订阅 → 席位闸 → 待接受上限
 * (min(max(剩余,1)×factor, cap),显式注入)→ 建 token(32hex,响应一次下发)。
 * 检查与插入非事务(竞态由 accept 端权威复检兜底);TTL 落库用存储时钟。
 */
import { AccountsErrors } from '../domain/errors.js';
import { normalizeValidEmail } from '../domain/fields.js';
import { generateInvitationToken, pendingInvitationLimit } from '../domain/org.js';
import { requireOwnerMembership } from './org-guards.js';
import type { UseCaseContext } from './context.js';

export interface InviteMemberResult {
  readonly invitationId: number;
  readonly token: string;
  /** 过期时刻(存储时钟 + TTL;由实现返回) */
  readonly expiresAt: Date;
}

export async function inviteMember(
  ctx: UseCaseContext,
  input: { orgId: number; operatorUserId: number; email: string },
): Promise<InviteMemberResult> {
  await requireOwnerMembership(ctx, { orgId: input.orgId, userId: input.operatorUserId });

  const email = normalizeValidEmail(input.email);
  if (email === null) throw AccountsErrors.business('email_invalid', { email: input.email });

  const subscription = await ctx.store.findActiveOrgSubscription(ctx.db, input.orgId);
  if (subscription === null) {
    throw AccountsErrors.business('org_no_subscription', { orgId: input.orgId });
  }
  const activeMembers = await ctx.store.countActiveMembers(ctx.db, input.orgId);
  if (activeMembers >= subscription.quantity) {
    throw AccountsErrors.business('seats_full', {
      orgId: input.orgId,
      active: activeMembers,
      quantity: subscription.quantity,
    });
  }
  const pending = await ctx.store.countPendingInvitations(ctx.db, input.orgId);
  const limit = pendingInvitationLimit(subscription.quantity - activeMembers, {
    factor: ctx.policy.invitationPendingFactor,
    cap: ctx.policy.invitationPendingCap,
  });
  if (pending >= limit) {
    throw AccountsErrors.business('invitations_full', { orgId: input.orgId, pending, limit });
  }

  const invitation = await ctx.store.insertInvitation(ctx.db, {
    orgId: input.orgId,
    email,
    token: generateInvitationToken(),
    invitedByUserId: input.operatorUserId,
    ttlMs: ctx.policy.invitationTtlMs,
  });
  return { invitationId: invitation.id, token: invitation.token, expiresAt: invitation.expiresAt };
}
