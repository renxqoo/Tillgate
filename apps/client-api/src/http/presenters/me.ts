/**
 * me 呈现：accounts 资料投影 + 钱包账户快照 → /v1/me wire 行（api-client MeInfo 口径）。
 * 入参用本地结构形状（accounts 根出口不导 port 行类型——结构兼容即成立）。
 */
import type { AccountSnapshot } from '@tokenlens/billing';

export interface ProfileView {
  id: number;
  subject: string;
  email: string | null;
  displayName: string | null;
  rateCardId: number | null;
  rateCardName: string | null;
  status: number;
  isEnterprise: boolean;
  rpmLimit: number | null;
  tpmLimit: number | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface MeInfo extends ProfileView {
  accounts: readonly AccountSnapshot[];
}

export function toMeInfo(profile: ProfileView, accounts: readonly AccountSnapshot[]): MeInfo {
  return { ...profile, accounts };
}
