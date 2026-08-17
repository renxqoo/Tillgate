/**
 * wallet 复式账本（业务无关，企业级会计表达）：
 *
 *   wallet_accounts        账户：kind ∈ {user, internal}——用户账户 (user_id, currency)、
 *                          内部科目账户 (code, currency)（platform_revenue 平台收入 /
 *                          outside 外部世界 / 业务自定义科目）；balance ≥ −credit_limit；
 *                          status ∈ {active, frozen}（风控冻结）
 *   wallet_transactions    交易批头：幂等键 (ref_type, ref_id, kind)；金额不在批头
 *   wallet_legs            腿：每笔交易 ≥2 腿、Σ 腿 = 0（有借必有贷，代码构造 +
 *                          对账测试）；每腿独立链式恒等 after = before + amount（DB check）
 *   wallet_authorizations  冻结单：account_id 定位持有人；(ref_type, ref_id) 幂等；
 *                          释放/超时审计在单据本身（不落交易，零额噪声行取消）
 *
 * 单腿规则：credit_line / freeze 为零额审计交易，单腿 amount=0（Σ=0 平凡成立）。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export const walletAccounts = pgTable(
  'wallet_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** user = 用户账户；internal = 内部科目账户 */
    kind: varchar('kind', { length: 8 }).notNull(),
    userId: bigint('user_id', { mode: 'number' }),
    /** 内部科目代码（platform_revenue / outside / 业务自定义），snake_case */
    code: varchar('code', { length: 64 }),
    currency: varchar('currency', { length: 3 }).notNull().default('CNY'),
    /** 可用口径 = balance + credit_limit − in_flight */
    balance: numeric('balance', { precision: 38, scale: 18 }).notNull().default('0'),
    inFlight: numeric('in_flight', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 授信地板（≥0；balance 不得低于 −credit_limit。0 = 纯预付） */
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
    // 地板只约束用户账户：内部科目（outside 镜像等）语义上可负，守恒由 Σ腿=0 保证
    check('wallet_accounts_balance_floor_ck', sql`${t.kind} = 'internal' or ${t.balance} >= -${t.creditLimit}`),
    check('wallet_accounts_status_ck', sql`${t.status} in ('active', 'frozen')`),
    uniqueIndex('wallet_accounts_user_uq')
      .on(t.userId, t.currency)
      .where(sql`kind = 'user'`),
    uniqueIndex('wallet_accounts_internal_uq')
      .on(t.code, t.currency)
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wallet_transactions_ref_kind_uq').on(t.refType, t.refId, t.kind),
    check(
      'wallet_transactions_kind_ck',
      sql`${t.kind} in ('credit', 'settle', 'refund', 'transfer', 'credit_line', 'freeze')`,
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
    index('wallet_authorizations_expiry_idx')
      .on(t.expiresAt)
      .where(sql`status = 'active' and expires_at is not null`),
  ],
);

/**
 * 建表（幂等 IF NOT EXISTS）——消费方接入时执行一次；
 * 测试用 deprovision 清场。
 */
/** 建表 DDL（幂等 IF NOT EXISTS）——provisionSql 供消费方贴入自己的版本化迁移 */
const WALLET_DDL: readonly string[] = [
  `
    create table if not exists wallet_accounts (
      id uuid primary key default gen_random_uuid(),
      kind varchar(8) not null,
      user_id bigint,
      code varchar(64),
      currency varchar(3) not null default 'CNY',
      balance numeric(38, 18) not null default 0,
      in_flight numeric(38, 18) not null default 0,
      credit_limit numeric(38, 18) not null default 0,
      status varchar(8) not null default 'active',
      updated_at timestamptz not null default now(),
      constraint wallet_accounts_identity_ck check (
        (kind = 'user' and user_id is not null and code is null)
        or (kind = 'internal' and code is not null and user_id is null)
      ),
      constraint wallet_accounts_floor_ck check (credit_limit >= 0 and in_flight >= 0),
      constraint wallet_accounts_balance_floor_ck check (kind = 'internal' or balance >= -credit_limit),
      constraint wallet_accounts_status_ck check (status in ('active', 'frozen'))
    )`,
  `
    create unique index if not exists wallet_accounts_user_uq
      on wallet_accounts (user_id, currency) where kind = 'user'`,
  `
    create unique index if not exists wallet_accounts_internal_uq
      on wallet_accounts (code, currency) where kind = 'internal'`,
  `
    create table if not exists wallet_transactions (
      id bigserial primary key,
      kind varchar(16) not null,
      ref_type varchar(32) not null,
      ref_id varchar(128) not null,
      memo varchar(255),
      credit_limit_after numeric(38, 18),
      created_at timestamptz not null default now(),
      constraint wallet_transactions_ref_kind_uq unique (ref_type, ref_id, kind),
      constraint wallet_transactions_kind_ck
        check (kind in ('credit', 'settle', 'refund', 'transfer', 'credit_line', 'freeze'))
    )`,
  `
    create index if not exists wallet_transactions_ref_idx
      on wallet_transactions (ref_type, created_at)`,
  `
    create table if not exists wallet_legs (
      id bigserial primary key,
      transaction_id bigint not null references wallet_transactions (id),
      account_id uuid not null references wallet_accounts (id),
      currency varchar(3) not null,
      amount numeric(38, 18) not null,
      balance_before numeric(38, 18) not null,
      balance_after numeric(38, 18) not null,
      constraint wallet_legs_chain_ck check (balance_after = balance_before + amount)
    )`,
  `
    create index if not exists wallet_legs_account_idx on wallet_legs (account_id, id)`,
  `
    create index if not exists wallet_legs_transaction_idx on wallet_legs (transaction_id)`,
  `
    create table if not exists wallet_authorizations (
      id uuid primary key default gen_random_uuid(),
      account_id uuid not null references wallet_accounts (id),
      ref_type varchar(32) not null,
      ref_id varchar(128) not null,
      amount numeric(38, 18) not null,
      status varchar(16) not null default 'active',
      settled_amount numeric(38, 18),
      release_reason varchar(64),
      expires_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint wallet_authorizations_ref_uq unique (ref_type, ref_id),
      constraint wallet_authorizations_amount_ck check (amount > 0),
      constraint wallet_authorizations_status_ck
        check (status in ('active', 'settled', 'released', 'expired'))
    )`,
  `
    create index if not exists wallet_authorizations_expiry_idx
      on wallet_authorizations (expires_at)
      where status = 'active' and expires_at is not null`,
];

/** 建表（幂等 IF NOT EXISTS）——消费方接入时执行一次；测试用 deprovision 清场 */
export async function provision(db: NodePgDatabase): Promise<void> {
  for (const ddl of WALLET_DDL) {
    await db.execute(sql.raw(ddl));
  }
}

/** 导出建表 DDL 文本：供消费方的版本化迁移工具（drizzle journal 等）收录 */
export function provisionSql(): readonly string[] {
  return WALLET_DDL;
}

/** 测试清场：drop 四表（业务环境勿用） */
export async function deprovision(db: NodePgDatabase): Promise<void> {
  await db.execute(sql`drop table if exists wallet_legs`);
  await db.execute(sql`drop table if exists wallet_authorizations`);
  await db.execute(sql`drop table if exists wallet_transactions`);
  await db.execute(sql`drop table if exists wallet_accounts`);
}
