/**
 * 注册归因(v1 referral.service applyReferral):畸形码/自邀/邀请人不可用(含封禁,
 * 防枚举)先行拒绝;单事务内「关系 + 双方注册奖励」同生共死(broken wallet 注入
 * 验证回滚,v1 测试锁定);重复归因由唯一索引兜底;bonus=0 建关系零入账。
 */
import { runTx } from '@tillgate/db';
import { AccountsErrors } from '../domain/errors.js';
import { isPositiveAmount } from '../domain/limits.js';
import { decodeAffCode, referralSignupRefId } from '../domain/referral.js';
import type { UseCaseContext } from './context.js';

export interface ApplyReferralResult {
  readonly applied: true;
  /** 是否实际入账(bonus=0 时仅建关系) */
  readonly bonusCredited: boolean;
}

export async function applyReferral(
  ctx: UseCaseContext,
  input: { inviteeUserId: number; affCode: string },
): Promise<ApplyReferralResult> {
  const inviterUserId = decodeAffCode(input.affCode);
  if (inviterUserId === null) throw AccountsErrors.business('referral_invalid_code');
  if (inviterUserId === input.inviteeUserId) throw AccountsErrors.business('referral_self_invite');
  if (!(await ctx.store.inviterActive(ctx.db, inviterUserId))) {
    throw AccountsErrors.business('referral_inviter_not_found');
  }

  const settings = await ctx.store.getMarketingSettings(ctx.db);
  const bonus = settings.referralSignupBonus;
  const withBonus = isPositiveAmount(bonus);

  return runTx(
    ctx.db,
    async (tx) => {
      const inserted = await ctx.store.insertReferral(tx, {
        inviterUserId,
        inviteeUserId: input.inviteeUserId,
      });
      if (inserted === 'already_referred') {
        throw AccountsErrors.business('referral_already_referred');
      }
      if (withBonus) {
        // 双方同额奖励;任一失败随事务回滚(关系与另一侧一并撤销)
        await ctx.walletCredit.credit(tx, {
          refType: 'referral',
          refId: referralSignupRefId(input.inviteeUserId, 'inviter'),
          userId: inviterUserId,
          amount: bonus,
          memo: '邀请注册奖励(邀请人)',
        });
        await ctx.walletCredit.credit(tx, {
          refType: 'referral',
          refId: referralSignupRefId(input.inviteeUserId, 'invitee'),
          userId: input.inviteeUserId,
          amount: bonus,
          memo: '邀请注册奖励(被邀请人)',
        });
      }
      return { applied: true as const, bonusCredited: withBonus };
    },
    ctx.txRetry,
  );
}
