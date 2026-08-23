/**
 * 推荐呈现：营销参数视图开关 + 概览行合并（accounts referralOverview + billing 佣金和）。
 */
import { Decimal } from '@tokenlens/billing';

export interface MarketingSettingsView {
  referralSignupBonus: string;
  referralCommissionRate: string;
}

export interface ReferralOverviewView {
  affCode: string;
  inviteUrl: string;
  signupBonus: string;
  commissionRate: string;
  invitees: ReadonlyArray<{
    inviteeUserId: number;
    inviteeEmail: string | null;
    inviteeDisplayName: string | null;
    status: number;
    createdAt: Date;
  }>;
}

/** GET /v1/referrals/config wire 行（全零 = 前端隐藏入口） */
export function referralConfigView(settings: MarketingSettingsView): {
  enabled: boolean;
  signupBonus: string;
  commissionRate: string;
} {
  const enabled =
    new Decimal(settings.referralSignupBonus).gt(0) ||
    new Decimal(settings.referralCommissionRate).gt(0);
  return {
    enabled,
    signupBonus: settings.referralSignupBonus,
    commissionRate: settings.referralCommissionRate,
  };
}

/** GET /v1/referrals wire 行（inviteeId/inviteeName = v1 字段名） */
export function referralOverviewRow(
  overview: ReferralOverviewView,
  totalCommission: string,
): {
  affCode: string;
  inviteUrl: string;
  signupBonus: string;
  commissionRate: string;
  invited: ReadonlyArray<{
    inviteeId: number;
    inviteeName: string | null;
    createdAt: Date;
    status: number;
  }>;
  totalCommission: string;
} {
  return {
    affCode: overview.affCode,
    inviteUrl: overview.inviteUrl,
    signupBonus: overview.signupBonus,
    commissionRate: overview.commissionRate,
    invited: overview.invitees.map((i) => ({
      inviteeId: i.inviteeUserId,
      inviteeName: i.inviteeDisplayName ?? i.inviteeEmail,
      createdAt: i.createdAt,
      status: i.status,
    })),
    totalCommission,
  };
}
