/**
 * 接受邀请(v1 org.service accept):快路径分型 → email 匹配 → 权威事务
 * (FOR UPDATE 锁订阅 → 复检席位 → 插入/复活成员 → CAS 翻转,失败即回滚)。
 * 过期判定在读时由存储时钟表达(惰性过期,B8)。
 */
import { runTx } from '@tokenlens/db';
import { AccountsErrors } from '../domain/errors.js';
import { invitationEmailMatches } from '../domain/org.js';
import { MEMBER_ROLES } from '../domain/org.js';
import type { UseCaseContext } from './context.js';

export async function acceptInvitation(
  ctx: UseCaseContext,
  input: { token: string; acceptorUserId: number },
): Promise<{ orgId: number }> {
  const snapshot = await ctx.store.findInvitationByToken(ctx.db, input.token);
  if (snapshot === null) throw AccountsErrors.business('invitation_invalid');
  if (snapshot.status === 2) throw AccountsErrors.business('invitation_revoked');
  if (snapshot.status === 1) throw AccountsErrors.business('invitation_already_accepted');
  if (snapshot.expired) throw AccountsErrors.business('invitation_expired');

  const acceptor = await ctx.store.findUserById(ctx.db, input.acceptorUserId);
  if (acceptor === null) throw AccountsErrors.business('user_not_found', { userId: input.acceptorUserId });
  if (!invitationEmailMatches({ email: acceptor.email, subject: acceptor.subject }, snapshot.email)) {
    throw AccountsErrors.business('invitation_email_mismatch');
  }

  return runTx(
    ctx.db,
    async (tx) => {
      const subscription = await ctx.store.lockActiveOrgSubscription(tx, snapshot.orgId);
      if (subscription === null) throw AccountsErrors.business('org_no_subscription', { orgId: snapshot.orgId });
      const activeMembers = await ctx.store.countActiveMembers(tx, snapshot.orgId);
      if (activeMembers >= subscription.quantity) {
        throw AccountsErrors.business('seats_full', {
          orgId: snapshot.orgId,
          active: activeMembers,
          quantity: subscription.quantity,
        });
      }
      await ctx.store.insertOrReviveMember(tx, {
        orgId: snapshot.orgId,
        userId: input.acceptorUserId,
        role: MEMBER_ROLES.MEMBER,
      });
      const flipped = await ctx.store.acceptInvitation(tx, {
        invitationId: snapshot.id,
        acceptedByUserId: input.acceptorUserId,
      });
      if (!flipped) throw AccountsErrors.business('invitation_invalid'); // 并发竞态:整事务回滚
      return { orgId: snapshot.orgId };
    },
    ctx.txRetry,
  );
}
