import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { referrals, transactions, users } from '@ai-gateway/db/schema';
import type { Ledger } from '@ai-gateway/ledger';

/**
 * 邀请返利（C3）：
 *   aff 码 = 「u{userId 的 base36}」（无新列——userId 是唯一事实源）
 *   注册链路：建号后 applyReferral（幂等：referrals.invitee 唯一 + 入账自然键）
 *   奖励：双方各得 REFERRAL_SIGNUP_BONUS（grantPromotionalCredit 幂等）
 *   佣金：worker 日结（见 worker runReferralCommission）
 */

export function encodeAffCode(userId: number): string {
  return `u${userId.toString(36)}`;
}

export function decodeAffCode(code: string): number | null {
  if (!code.startsWith('u')) return null;
  const id = Number.parseInt(code.slice(1), 36);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export interface ReferralResult {
  applied: boolean;
  reason?: 'invalid_code' | 'self_invite' | 'already_referred' | 'inviter_not_found';
}

export async function applyReferral(
  db: Db,
  ledger: Ledger,
  args: { inviteeId: number; affCode: string; signupBonus: number },
): Promise<ReferralResult> {
  const inviterId = decodeAffCode(args.affCode.trim());
  if (inviterId === null) return { applied: false, reason: 'invalid_code' };
  if (inviterId === args.inviteeId) return { applied: false, reason: 'self_invite' };

  // 唯一约束 referrals_invitee_uq 兜底并发（一人只能被邀一次）
  const inserted = await db
    .insert(referrals)
    .values({ inviterUserId: inviterId, inviteeUserId: args.inviteeId, status: 0 })
    .onConflictDoNothing({ target: referrals.inviteeUserId })
    .returning({ id: referrals.id });
  if (inserted.length === 0) return { applied: false, reason: 'already_referred' };

  const inviter = await db.query.users.findFirst({
    where: eq(users.id, inviterId),
    columns: { id: true, status: true },
  });
  if (!inviter || inviter.status !== 0) return { applied: false, reason: 'inviter_not_found' };

  if (args.signupBonus > 0) {
    // 双方奖励（自然键幂等：invitee 只发生一次）
    await ledger
      .grantPromotionalCredit({
        operationId: `referral-signup:${args.inviteeId}:inviter`,
        userId: inviterId,
        amount: String(args.signupBonus),
        kind: 'referral_signup',
        refId: encodeAffCode(args.inviteeId),
        remark: `邀请奖励（邀请人）+${args.signupBonus}`,
      })
      .catch(() => undefined);
    await ledger
      .grantPromotionalCredit({
        operationId: `referral-signup:${args.inviteeId}:invitee`,
        userId: args.inviteeId,
        amount: String(args.signupBonus),
        kind: 'referral_signup',
        refId: encodeAffCode(inviterId),
        remark: `受邀注册奖励 +${args.signupBonus}`,
      })
      .catch(() => undefined);
  }
  return { applied: true };
}

export interface InviteOverview {
  affCode: string;
  inviteUrl: string;
  signupBonus: number;
  commissionRate: number;
  invited: Array<{ inviteeId: number; inviteeName: string | null; createdAt: string; status: number }>;
  totalCommission: string;
}

export async function inviteOverview(
  db: Db,
  userId: number,
  opts: { frontendUrl: string; signupBonus: number; commissionRate: number },
): Promise<InviteOverview> {
  const rows = await db
    .select({
      inviteeId: referrals.inviteeUserId,
      createdAt: referrals.createdAt,
      status: referrals.status,
      inviteeName: users.displayName,
    })
    .from(referrals)
    .leftJoin(users, eq(users.id, referrals.inviteeUserId))
    .where(eq(referrals.inviterUserId, userId))
    .orderBy(desc(referrals.createdAt))
    .limit(100);
  const commission = await db
    .select({ total: sql<string>`coalesce(sum(${transactions.amount}), 0)` })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.type, 'commission')));
  const affCode = encodeAffCode(userId);
  return {
    affCode,
    inviteUrl: `${opts.frontendUrl}/register?aff=${affCode}`,
    signupBonus: opts.signupBonus,
    commissionRate: opts.commissionRate,
    invited: rows.map((r) => ({
      inviteeId: r.inviteeId,
      inviteeName: r.inviteeName ?? null,
      createdAt: r.createdAt.toISOString(),
      status: r.status,
    })),
    totalCommission: commission[0]?.total ?? '0',
  };
}
