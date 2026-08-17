/**
 * wallet 表（业务无关三表）：
 *
 *   wallet_accounts        账户：balance + in_flight（冻结在途）
 *   wallet_authorizations  冻结单：两阶段第一步，(ref_type, ref_id) 幂等
 *   wallet_transactions    流水：有符号金额，balance_after = balance_before + amount（链式不变量下沉 DB check）
 *
 * 幂等域：transactions 按 (ref_type, ref_id, kind) 唯一——同一业务键每种动作至多一条，
 * credit 与 refund 各占一域互不顶撞（电商充值/退款即同款语义）。
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
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export const walletAccounts = pgTable(
  'wallet_accounts',
  {
    userId: bigint('user_id', { mode: 'number' }).primaryKey(),
    /** 可用口径 = balance − in_flight（两处均非负，DB 兜底） */
    balance: numeric('balance', { precision: 38, scale: 18 }).notNull().default('0'),
    inFlight: numeric('in_flight', { precision: 38, scale: 18 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('wallet_accounts_nonnegative_ck', sql`${t.balance} >= 0 and ${t.inFlight} >= 0`),
  ],
);

export const walletAuthorizations = pgTable(
  'wallet_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => walletAccounts.userId),
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
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => walletAccounts.userId),
    /** credit（+）/ settle（−）/ refund（−）/ release（0，审计行） */
    kind: varchar('kind', { length: 16 }).notNull(),
    refType: varchar('ref_type', { length: 32 }).notNull(),
    refId: varchar('ref_id', { length: 128 }).notNull(),
    amount: numeric('amount', { precision: 38, scale: 18 }).notNull(),
    balanceBefore: numeric('balance_before', { precision: 38, scale: 18 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 38, scale: 18 }).notNull(),
    authorizationId: uuid('authorization_id'),
    memo: varchar('memo', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('wallet_transactions_ref_kind_uq').on(t.refType, t.refId, t.kind),
    check('wallet_transactions_kind_ck', sql`${t.kind} in ('credit', 'settle', 'release', 'refund')`),
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
      user_id bigint primary key,
      balance numeric(38, 18) not null default 0,
      in_flight numeric(38, 18) not null default 0,
      updated_at timestamptz not null default now(),
      constraint wallet_accounts_nonnegative_ck check (balance >= 0 and in_flight >= 0)
    )`);
  await db.execute(sql`
    create table if not exists wallet_authorizations (
      id uuid primary key default gen_random_uuid(),
      user_id bigint not null references wallet_accounts(user_id),
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
    )`);
  await db.execute(sql`
    create index if not exists wallet_authorizations_expiry_idx
      on wallet_authorizations (expires_at)
      where status = 'active' and expires_at is not null`);
  await db.execute(sql`
    create table if not exists wallet_transactions (
      id bigserial primary key,
      user_id bigint not null references wallet_accounts(user_id),
      kind varchar(16) not null,
      ref_type varchar(32) not null,
      ref_id varchar(128) not null,
      amount numeric(38, 18) not null,
      balance_before numeric(38, 18) not null,
      balance_after numeric(38, 18) not null,
      authorization_id uuid,
      memo varchar(255),
      created_at timestamptz not null default now(),
      constraint wallet_transactions_ref_kind_uq unique (ref_type, ref_id, kind),
      constraint wallet_transactions_kind_ck check (kind in ('credit', 'settle', 'release', 'refund')),
      constraint wallet_transactions_chain_ck check (balance_after = balance_before + amount)
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
