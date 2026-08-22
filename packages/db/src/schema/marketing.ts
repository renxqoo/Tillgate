import { check, bigint, integer, numeric, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { admins } from './admins.js';

/**
 * marketing_settings — 营销参数（拉新资金配置，管理面唯一入口）。
 *
 * 单行表（id 恒 1，CHECK 钉死）：注册赠送 / 邀请注册双奖励 / 邀请人佣金比例。
 * 2026-08-21 起从 env 迁入（GIFT_AMOUNT / REFERRAL_SIGNUP_BONUS /
 * REFERRAL_COMMISSION_RATE 已删除）——资金参数改值即时生效且全程审计。
 *
 * 生效语义：下一动作生效、历史不重算（已入账赠送/佣金按当时参数不动；
 * append-only 账本不冲正，幂等键不破坏）。
 */
export const marketingSettings = pgTable(
  'marketing_settings',
  {
    id: integer('id').primaryKey().default(1),
    /** 无条件注册赠送（元/人；0 = 关闭）——幂等锚 gift + signup:{userId} */
    signupGiftAmount: numeric('signup_gift_amount', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 邀请注册双方奖励（元/人；0 = 关闭）——幂等锚 referral-signup:{inviteeId}:{side} */
    referralSignupBonus: numeric('referral_signup_bonus', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 邀请人佣金比例（被邀请人日消费 × 比例；0 = 关闭）——幂等锚 referral-commission:{inviter}:{yyyyMMdd} */
    referralCommissionRate: numeric('referral_commission_rate', { precision: 38, scale: 18 }).notNull().default('0'),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => admins.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('marketing_settings_single_row_ck', sql`${t.id} = 1`),
    check('marketing_settings_gift_ck', sql`${t.signupGiftAmount} >= 0`),
    check('marketing_settings_bonus_ck', sql`${t.referralSignupBonus} >= 0`),
    check('marketing_settings_rate_ck', sql`${t.referralCommissionRate} >= 0 and ${t.referralCommissionRate} <= 1`),
  ],
);
