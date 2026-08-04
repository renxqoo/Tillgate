import {
  index,
  pgTable,
  bigserial,
  bigint,
  varchar,
  smallint,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
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
    /** 0 普通用户 / 1 管理员 */
    role: smallint('role').notNull().default(0),
    rateCardId: bigint('rate_card_id', { mode: 'number' }).references(() => rateCards.id),
    /** 余额（厘），权威账本字段，只允许通过结算事务原子修改（预扣/补扣/退款） */
    balance: bigint('balance', { mode: 'number' }).notNull().default(0),
    /** 0 正常 / 1 封禁 / 2 注销 */
    status: smallint('status').notNull().default(0),
    freezeReason: varchar('freeze_reason', { length: 128 }),
    /** 用户级限流，NULL=继承全局默认 */
    rpmLimit: bigint('rpm_limit', { mode: 'number' }),
    tpmLimit: bigint('tpm_limit', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_issuer_subject_uq').on(t.issuer, t.subject),
    index('users_rate_card_id_idx').on(t.rateCardId),
  ],
);
