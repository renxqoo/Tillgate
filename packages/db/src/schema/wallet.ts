/**
 * wallet 复式账本四表（表定义唯一家在本包）：
 *
 *   wallet_accounts        账户：kind ∈ {user, internal}——用户账户 (user_id, currency)、
 *                          内部科目账户 (code, currency, shard)（platform_revenue 平台收入 /
 *                          outside 外部世界 / 业务自定义科目）；结算补扣可形成负 balance；
 *                          status ∈ {active, frozen}（风控冻结）
 *   wallet_transactions    交易批头：幂等键 (ref_type, ref_id, kind)；金额不在批头
 *   wallet_legs            腿：每笔交易 ≥2 腿、Σ 腿 = 0（有借必有贷）；每腿独立链式
 *                          恒等 after = before + amount（DB check + insert 前置触发器）
 *   wallet_authorizations  冻结单：(ref_type, ref_id) 幂等；active → settled/released/expired
 *
 * 单腿规则：credit_line / freeze 为零额审计交易，单腿 amount=0（Σ=0 平凡成立）。
 * 完整提交期不变量（延迟约束触发器）由 0059 迁移落库——DDL 单一真源在迁移文件。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const walletAccounts = pgTable(
  'wallet_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** user = 用户账户；internal = 内部科目账户 */
    kind: varchar('kind', { length: 8 }).notNull(),
    userId: bigint('user_id', { mode: 'number' }),
    /** 内部科目代码（platform_revenue / outside / 业务自定义），snake_case */
    code: varchar('code', { length: 64 }),
    /** internal 物理分片；user 恒为 0。逻辑科目仍由 code/currency 标识。 */
    shard: integer('shard').notNull().default(0),
    currency: varchar('currency', { length: 3 }).notNull().default('CNY'),
    /** 可用口径 = balance + credit_limit − in_flight */
    balance: numeric('balance', { precision: 38, scale: 18 }).notNull().default('0'),
    inFlight: numeric('in_flight', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 新请求准入授信额度（≥0）；不限制已发生消费的结算补扣负余额。 */
    creditLimit: numeric('credit_limit', { precision: 38, scale: 18 }).notNull().default('0'),
    /** active / frozen（风控冻结：冻结账户拒绝一切资金变动） */
    status: varchar('status', { length: 8 }).notNull().default('active'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'wallet_accounts_identity_ck',
      sql`(${t.kind} = 'user' and ${t.userId} is not null and ${t.code} is null)
          or (${t.kind} = 'internal' and ${t.code} is not null and ${t.userId} is null)`,
    ),
    check('wallet_accounts_floor_ck', sql`${t.creditLimit} >= 0 and ${t.inFlight} >= 0`),
    check('wallet_accounts_status_ck', sql`${t.status} in ('active', 'frozen')`),
    check(
      'wallet_accounts_shard_ck',
      sql`(${t.kind} = 'user' and ${t.shard} = 0)
          or (${t.kind} = 'internal' and ${t.shard} between 0 and 255)`,
    ),
    uniqueIndex('wallet_accounts_user_uq')
      .on(t.userId, t.currency)
      .where(sql`kind = 'user'`),
    uniqueIndex('wallet_accounts_internal_uq')
      .on(t.code, t.currency, t.shard)
      .where(sql`kind = 'internal'`),
  ],
);

export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** credit / settle / refund / transfer / credit_line / freeze */
    kind: varchar('kind', { length: 16 }).notNull(),
    refType: varchar('ref_type', { length: 32 }).notNull(),
    refId: varchar('ref_id', { length: 128 }).notNull(),
    memo: varchar('memo', { length: 255 }),
    /** credit_line 行的新授信额（其余 kind 为 NULL）——幂等重放的读回依据 */
    creditLimitAfter: numeric('credit_limit_after', { precision: 38, scale: 18 }),
    /** freeze 行首次提交后的目标状态——稳定幂等回执，不能读取账户当前状态 */
    frozenAfter: boolean('frozen_after'),
    /** 规范化命令 SHA-256；NULL 仅兼容引入指纹前的历史交易。 */
    commandFingerprint: varchar('command_fingerprint', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_transactions_ref_kind_uq').on(t.refType, t.refId, t.kind),
    check(
      'wallet_transactions_kind_ck',
      sql`${t.kind} in ('credit', 'settle', 'refund', 'transfer', 'credit_line', 'freeze')`,
    ),
    check(
      'wallet_transactions_receipt_ck',
      sql`(${t.kind} = 'freeze' and ${t.frozenAfter} is not null and ${t.creditLimitAfter} is null)
          or (${t.kind} = 'credit_line' and ${t.frozenAfter} is null and ${t.creditLimitAfter} is not null)
          or (${t.kind} not in ('freeze', 'credit_line') and ${t.frozenAfter} is null and ${t.creditLimitAfter} is null)`,
    ),
    index('wallet_transactions_ref_idx').on(t.refType, t.createdAt),
  ],
);

export const walletLegs = pgTable(
  'wallet_legs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    transactionId: bigint('transaction_id', { mode: 'number' })
      .notNull()
      .references(() => walletTransactions.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => walletAccounts.id),
    currency: varchar('currency', { length: 3 }).notNull(),
    /** 有符号：正 = 入（贷），负 = 出（借）；同交易各腿合计恒为 0 */
    amount: numeric('amount', { precision: 38, scale: 18 }).notNull(),
    balanceBefore: numeric('balance_before', { precision: 38, scale: 18 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 38, scale: 18 }).notNull(),
  },
  (t) => [
    check('wallet_legs_chain_ck', sql`${t.balanceAfter} = ${t.balanceBefore} + ${t.amount}`),
    index('wallet_legs_account_idx').on(t.accountId, t.id),
    index('wallet_legs_transaction_idx').on(t.transactionId),
    index('wallet_legs_account_transaction_idx').on(t.accountId, t.transactionId),
  ],
);

export const walletAuthorizations = pgTable(
  'wallet_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => walletAccounts.id),
    refType: varchar('ref_type', { length: 32 }).notNull(),
    refId: varchar('ref_id', { length: 128 }).notNull(),
    amount: numeric('amount', { precision: 38, scale: 18 }).notNull(),
    /** active → settled（实扣落定）/ released（取消）/ expired（超时，worker 扫描） */
    status: varchar('status', { length: 16 }).notNull().default('active'),
    settledAmount: numeric('settled_amount', { precision: 38, scale: 18 }),
    releaseReason: varchar('release_reason', { length: 64 }),
    memo: varchar('memo', { length: 255 }),
    /** authorize 原命令指纹；NULL 仅兼容历史冻结单。 */
    authorizeFingerprint: varchar('authorize_fingerprint', { length: 64 }),
    /** 主动 release 命令指纹；expired 保持 NULL。 */
    releaseFingerprint: varchar('release_fingerprint', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_authorizations_ref_uq').on(t.refType, t.refId),
    check('wallet_authorizations_amount_ck', sql`${t.amount} > 0`),
    check(
      'wallet_authorizations_status_ck',
      sql`${t.status} in ('active', 'settled', 'released', 'expired')`,
    ),
    check(
      'wallet_authorizations_state_ck',
      sql`(${t.status} = 'active' and ${t.settledAmount} is null and ${t.releaseReason} is null)
          or (${t.status} = 'settled' and ${t.settledAmount} > 0 and ${t.settledAmount} <= ${t.amount} and ${t.releaseReason} is null)
          or (${t.status} in ('released', 'expired') and ${t.settledAmount} is null and ${t.releaseReason} is not null)`,
    ),
    index('wallet_authorizations_account_active_idx')
      .on(t.accountId)
      .where(sql`status = 'active'`),
    index('wallet_authorizations_expiry_idx')
      .on(t.expiresAt)
      .where(sql`status = 'active' and expires_at is not null`),
  ],
);
