import {
  index,
  pgTable,
  bigserial,
  bigint,
  varchar,
  smallint,
  timestamp,
  uniqueIndex,
  numeric,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { rateCards } from './billing.js';

/**
 * users — 用户/企业账户（data-model.md §3.1）
 * 唯一键 (issuer, subject)：OIDC sub 仅在 issuer 内唯一；本地账号 issuer 固定 'local'
 */
export const users = pgTable(
  'users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    issuer: varchar('issuer', { length: 64 }).notNull(),
    subject: varchar('subject', { length: 255 }).notNull(),
    identityProvider: varchar('identity_provider', { length: 16 }).notNull(),
    email: varchar('email', { length: 255 }),
    displayName: varchar('display_name', { length: 64 }),
    rateCardId: bigint('rate_card_id', { mode: 'number' }).references(() => rateCards.id),
    /** 已结算余额（元）；信用模型下可为负，下限 -credit_limit。真实结算/充值/调账才修改。 */
    balance: numeric('balance', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 所有未终结请求的在途预估敞口（元）。仅用于并发熔断，不冻结余额。 */
    reservedBalance: numeric('reserved_balance', { precision: 38, scale: 18 })
      .notNull()
      .default('0'),
    /**
     * 透支上限（元，>=0）。信用模型：balance 允许降到 -credit_limit；
     * 请求前用 balance + credit_limit - reserved >= 预估 做并发熔断，完成后按实际金额扣费。
     * 默认 0 = 不透支（与旧模型一致）；管理员可按用户调高。
     */
    creditLimit: numeric('credit_limit', { precision: 38, scale: 18 }).notNull().default('0'),
    /**
     * 每日花费上限（元，NULL=不限）。防羊毛党「细水长流」：当日累计消费（已结算 consume）
     * + 在途敞口 + 本次预估不得超过。RPM/TPM 只挡频率，这个挡总量。
     */
    dailySpendLimit: numeric('daily_spend_limit', { precision: 38, scale: 18 }),
    /** 0 正常 / 1 封禁 / 2 注销 */
    status: smallint('status').notNull().default(0),
    freezeReason: varchar('freeze_reason', { length: 128 }),
    /** 用户级限流，NULL=继承全局默认 */
    rpmLimit: bigint('rpm_limit', { mode: 'number' }),
    tpmLimit: bigint('tpm_limit', { mode: 'number' }),
    /**
     * 本地账号密码哈希（scrypt，格式：saltHex:hashHex:N:r:p）。
     * NULL = OIDC 用户 / 尚未设置密码（本地账号管理员开通时设置）。
     */
    passwordHash: varchar('password_hash', { length: 255 }),
    /** 最近一次登录时间（登录成功时更新） */
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_issuer_subject_uq').on(t.issuer, t.subject),
    index('users_rate_card_id_idx').on(t.rateCardId),
    // 信用模型：balance 可为负，但不得低于 -credit_limit；在途敞口非负。
    check('users_reserved_balance_nonnegative_ck', sql`${t.reservedBalance} >= 0`),
    check('users_balance_credit_floor_ck', sql`${t.balance} >= -${t.creditLimit}`),
  ],
);
