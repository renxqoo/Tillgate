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
  boolean,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { rateCards } from './billing.js';
import { ACCOUNT_STATUS } from './account-status.js';

/**
 * users — 用户/企业账户
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
    /**
     * 每日花费上限（元，NULL=不限）。防羊毛党「细水长流」：当日累计消费（已结算 consume）
     * + 在途敞口 + 本次预估不得超过。RPM/TPM 只挡频率，这个挡总量。
     * （本表不设 balance/reserved_balance/credit_limit 列——资金事实唯一在 wallet。）
     */
    dailySpendLimit: numeric('daily_spend_limit', { precision: 38, scale: 18 }),
    /** 账号状态：ACCOUNT_STATUS（0 正常 / 1 封禁 / 2 注销）；CHECK users_status_ck 兜底非法值 */
    status: smallint('status').notNull().default(ACCOUNT_STATUS.ACTIVE),
    /** 是否企业用户：企业用户可购买团队套餐（支持席位）；个人用户只能买个人套餐（固定 1 席） */
    isEnterprise: boolean('is_enterprise').notNull().default(false),
    freezeReason: varchar('freeze_reason', { length: 128 }),
    /** 用户级限流，NULL=继承全局默认 */
    rpmLimit: bigint('rpm_limit', { mode: 'number' }),
    tpmLimit: bigint('tpm_limit', { mode: 'number' }),
    /** 最近一次登录时间（登录成功时更新） */
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_issuer_subject_uq').on(t.issuer, t.subject),
    // 本地账号 email 唯一（登录标识；NULL 排除——OIDC 用户/无邮箱测试账号不受约束）
    uniqueIndex('users_local_email_uq')
      .on(t.email)
      .where(sql`${t.issuer} = 'local' and ${t.email} is not null`),
    index('users_rate_card_id_idx').on(t.rateCardId),
    // 集合与 ACCOUNT_STATUS 一致（新增状态须同步常量与本约束）
    check('users_status_ck', sql`${t.status} in (0, 1, 2)`),
  ],
);
