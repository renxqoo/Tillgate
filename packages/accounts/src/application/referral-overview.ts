/**
 * 推荐概览:开关/aff 码/邀请链接/被邀名单;
 * totalCommission 拆归 app 组合(billing facade)。
 */
import { encodeAffCode, inviteUrl } from '../domain/referral.js';
import { referralProgramEnabled } from '../domain/marketing.js';
import type { InviteeView } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export interface ReferralOverview {
  readonly enabled: boolean;
  readonly affCode: string;
  readonly inviteUrl: string;
  readonly signupBonus: string;
  readonly commissionRate: string;
  readonly invitees: readonly InviteeView[];
}

export async function referralOverview(
  ctx: UseCaseContext,
  input: { userId: number; frontendBaseUrl: string },
): Promise<ReferralOverview> {
  const settings = await ctx.store.getMarketingSettings(ctx.db);
  const affCode = encodeAffCode(input.userId);
  const invitees = await ctx.store.listInvitees(ctx.db, {
    inviterUserId: input.userId,
    limit: ctx.policy.referralInviteeLimit,
  });
  return {
    enabled: referralProgramEnabled(settings),
    affCode,
    inviteUrl: inviteUrl(input.frontendBaseUrl, affCode),
    signupBonus: settings.referralSignupBonus,
    commissionRate: settings.referralCommissionRate,
    invitees,
  };
}
