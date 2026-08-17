/**
 * wallet 表（业务无关三表）：
 *
 *   wallet_accounts        账户：(user_id, currency) 复合主键——一币一账互不净额；
 *                          balance ≥ −credit_limit（授信地板，0 = 纯预付）
 *   wallet_authorizations  冻结单：两阶段第一步，(ref_type, ref_id) 幂等（键即业务身份，
 *                          不含币种维度——同一笔业务单跨币种顶撞即报错）
 *   wallet_transactions    流水：有符号金额，balance_after = balance_before + amount（链式
 *                          不变量下沉 DB check）；credit_line 审计行 amount=0 不动余额
 *
 * 幂等域：transactions 按 (ref_type, ref_id, kind) 唯一——同一业务键每种动作至多一条。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export const walletAccounts = pgTable(
  'wallet_accounts',
  {
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    /** 币种（ISO 4217 三字母；缺省 CNY——单币种业务零感知） */
    currency: varchar('currency', { length: 3 }).notNull().default('CNY'),
    /** 可用口径 = balance + credit_limit − in_flight */
    balance: numeric('balance', { precision: 38, scale: 18 }).notNull().default('0'),
    inFlight: numeric('in_flight', { precision: 38, scale: 18 }).notNull().default('0'),
    /** 授信地板（≥0；balance 不得低于 −credit_limit。0 = 纯预付） */
    creditLimit: numeric('credit_limit', { precision: 38, scale: 18 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.currency] }),
    check('wallet_accounts_floor_ck', sql`${t.creditLimit} >= 0 and ${t.inFlight} >= 0`),
    check('wallet_accounts_balance_floor_ck', sql`${t.balance} >= -${t.creditLimit}`),
  ],
);

export const walletAuthorizations = pgTable(
  'wallet_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('CNY'),
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
    unique('wallet_authorizations_ref_uq').on(t.refType, t.refId),
    foreignKey({
      columns: [t.userId, t.currency],
      foreignColumns: [walletAccounts.userId, walletAccounts.currency],
    }),
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

export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('CNY'),
    /** credit（+）/ settle（−）/ refund（−）/ release（0）/ credit_line（0，授信审计） */
    kind: varchar('kind', { length: 16 }).notNull(),
    refType: varchar('ref_type', { length: 32 }).notNull(),
    refId: varchar('ref_id', { length: 128 }).notNull(),
    amount: numeric('amount', { precision: 38, scale: 18 }).notNull(),
    balanceBefore: numeric('balance_before', { precision: 38, scale: 18 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 38, scale: 18 }).notNull(),
    /** credit_line 行的新授信额（其余 kind 为 NULL）——幂等重放的读回依据 */
    creditLimitAfter: numeric('credit_limit_after', { precision: 38, scale: 18 }),
    authorizationId: uuid('authorization_id'),
    memo: varchar('memo', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('wallet_transactions_ref_kind_uq').on(t.refType, t.refId, t.kind),
    foreignKey({
      columns: [t.userId, t.currency],
      foreignColumns: [walletAccounts.userId, walletAccounts.currency],
    }),
    check(
      'wallet_transactions_kind_ck',
      sql`${t.kind} in ('credit', 'settle', 'release', 'refund', 'credit_line')`,
    ),
    check('wallet_transactions_chain_ck', sql`${t.balanceAfter} = ${t.balanceBefore} + ${t.amount}`),
    index('wallet_transactions_user_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * 建表（幂等 IF NOT EXISTS）——消费方接入时执行一次；
 * 测试用 deprovision 清场。
 */
export async function provision(db: NodePgDatabase): Promise<void> {
  await db.execute(sql`
    create table if not exists wallet_accounts (
      user_id bigint not null,
      currency varchar(3) not null default 'CNY',
      balance numeric(38, 18) not null default 0,
      in_flight numeric(38, 18) not null default 0,
      credit_limit numeric(38, 18) not null default 0,
      updated_at timestamptz not null default now(),
      primary key (user_id, currency),
      constraint wallet_accounts_floor_ck check (credit_limit >= 0 and in_flight >= 0),
      constraint wallet_accounts_balance_floor_ck check (balance >= -credit_limit)
    )`);
  await db.execute(sql`
    create table if not exists wallet_authorizations (
      id uuid primary key default gen_random_uuid(),
      user_id bigint not null,
      currency varchar(3) not null default 'CNY',
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
        check (status in ('active', 'settled', 'released', 'expired')),
      constraint wallet_authorizations_account_fk
        foreign key (user_id, currency) references wallet_accounts (user_id, currency)
    )`);
  await db.execute(sql`
    create index if not exists wallet_authorizations_expiry_idx
      on wallet_authorizations (expires_at)
      where status = 'active' and expires_at is not null`);
  await db.execute(sql`
    create table if not exists wallet_transactions (
      id bigserial primary key,
      user_id bigint not null,
      currency varchar(3) not null default 'CNY',
      kind varchar(16) not null,
      ref_type varchar(32) not null,
      ref_id varchar(128) not null,
      amount numeric(38, 18) not null,
      balance_before numeric(38, 18) not null,
      balance_after numeric(38, 18) not null,
      credit_limit_after numeric(38, 18),
      authorization_id uuid,
      memo varchar(255),
      created_at timestamptz not null default now(),
      constraint wallet_transactions_ref_kind_uq unique (ref_type, ref_id, kind),
      constraint wallet_transactions_kind_ck
        check (kind in ('credit', 'settle', 'release', 'refund', 'credit_line')),
      constraint wallet_transactions_chain_ck check (balance_after = balance_before + amount),
      constraint wallet_transactions_account_fk
        foreign key (user_id, currency) references wallet_accounts (user_id, currency)
    )`);
  await db.execute(sql`
    create index if not exists wallet_transactions_user_idx
      on wallet_transactions (user_id, created_at)`);
}

/** 测试清场：drop 三表（业务环境勿用） */
export async function deprovision(db: NodePgDatabase): Promise<void> {
  await db.execute(sql`drop table if exists wallet_transactions`);
  await db.execute(sql`drop table if exists wallet_authorizations`);
  await db.execute(sql`drop table if exists wallet_accounts`);
}
