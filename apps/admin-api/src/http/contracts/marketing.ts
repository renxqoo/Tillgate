/**
 * 营销/邀请域契约（P3;v1 routes/marketing.ts + referrals.ts 的内联 zod 收口）。
 * 金额十进制字符串与费率 [0,1] 的正则逐字随迁 v1（含最大 18 位小数界）。
 */
import * as z from 'zod';

const amount = z
  .string()
  .regex(
    /^\d{1,10}(\.\d{1,18})?$/,
    'Amount must be a non-negative decimal string (max 18 decimal places)',
  );
const rate = z
  .string()
  .regex(
    /^(?:0(?:\.\d{1,18})?|1(?:\.0{1,18})?)$/,
    'Rate must be between 0 and 1 (max 18 decimal places)',
  );

export const marketingContracts = {
  updateSettings: z.object({
    signupGiftAmount: amount,
    referralSignupBonus: amount,
    referralCommissionRate: rate,
  }),
};

/** 返利流水分类词表（wire 面;物理投影在 billing adapter 单点） */
export const REFERRAL_KINDS = ['commission', 'referral_signup', 'gift'] as const;

export const referralContracts = {
  /** 关系封禁/恢复：0 停发 1 恢复（accounts REFERRAL_STATUSES 同值域） */
  patchRelation: z.object({ status: z.union([z.literal(0), z.literal(1)]) }),
};
