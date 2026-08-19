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
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash } from 'node:crypto';

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
    check(
      'wallet_accounts_balance_floor_ck',
      sql`${t.kind} = 'internal' or ${t.balance} >= -${t.creditLimit}`,
    ),
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
      frozen_after boolean,
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
      memo varchar(255),
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

/** v2：从早期 IF NOT EXISTS schema 升级到有提交期不变量保护的账本。 */
const WALLET_INVARIANT_DDL: readonly string[] = [
  `alter table wallet_transactions add column if not exists frozen_after boolean`,
  `alter table wallet_authorizations add column if not exists memo varchar(255)`,
  `create index if not exists wallet_authorizations_account_active_idx
     on wallet_authorizations (account_id) where status = 'active'`,
  `create index if not exists wallet_legs_account_transaction_idx
     on wallet_legs (account_id, transaction_id desc)`,
  `do $$
   begin
     if not exists (
       select 1 from pg_constraint
       where conname = 'wallet_transactions_receipt_ck'
         and conrelid = 'wallet_transactions'::regclass
     ) then
       alter table wallet_transactions add constraint wallet_transactions_receipt_ck check (
         (kind = 'freeze' and frozen_after is not null and credit_limit_after is null)
         or (kind = 'credit_line' and frozen_after is null and credit_limit_after is not null)
         or (kind not in ('freeze', 'credit_line') and frozen_after is null and credit_limit_after is null)
       );
     end if;
     if not exists (
       select 1 from pg_constraint
       where conname = 'wallet_authorizations_state_ck'
         and conrelid = 'wallet_authorizations'::regclass
     ) then
       alter table wallet_authorizations add constraint wallet_authorizations_state_ck check (
         (status = 'active' and settled_amount is null and release_reason is null)
         or (status = 'settled' and settled_amount > 0 and settled_amount <= amount and release_reason is null)
         or (status in ('released', 'expired') and settled_amount is null and release_reason is not null)
       );
     end if;
   end $$`,
  `create or replace function wallet_guard_leg_insert() returns trigger language plpgsql as $$
   declare current_balance numeric(38,18); account_currency varchar(3);
   begin
     select balance, currency into current_balance, account_currency
       from wallet_accounts where id = new.account_id for update;
     if not found then
       raise exception 'wallet leg account % missing', new.account_id using errcode = '23514';
     end if;
     if account_currency <> new.currency then
       raise exception 'wallet leg currency % differs from account currency %', new.currency, account_currency using errcode = '23514';
     end if;
     if current_balance <> new.balance_before then
       raise exception 'wallet leg chain is not continuous for account %', new.account_id using errcode = '23514';
     end if;
     return new;
   end $$`,
  `drop trigger if exists wallet_legs_insert_guard on wallet_legs`,
  `create trigger wallet_legs_insert_guard before insert on wallet_legs
     for each row execute function wallet_guard_leg_insert()`,
  `create or replace function wallet_reject_ledger_mutation() returns trigger language plpgsql as $$
   begin
     raise exception 'wallet ledger rows are immutable' using errcode = '23514';
   end $$`,
  `drop trigger if exists wallet_legs_immutable on wallet_legs`,
  `create trigger wallet_legs_immutable before update or delete on wallet_legs
     for each row execute function wallet_reject_ledger_mutation()`,
  `drop trigger if exists wallet_transactions_immutable on wallet_transactions`,
  `create trigger wallet_transactions_immutable before update or delete on wallet_transactions
     for each row execute function wallet_reject_ledger_mutation()`,
  `create or replace function wallet_assert_transaction_balanced() returns trigger language plpgsql as $$
   declare target_id bigint; target_kind varchar(16); leg_count bigint; total numeric(38,18);
   begin
     if tg_table_name = 'wallet_transactions' then
       target_id := new.id;
     else
       target_id := new.transaction_id;
     end if;
     select kind into target_kind from wallet_transactions where id = target_id;
     if not found then return null; end if;
     select count(*), coalesce(sum(amount), 0) into leg_count, total
       from wallet_legs where transaction_id = target_id;
     if total <> 0 then
       raise exception 'wallet transaction % is unbalanced: %', target_id, total using errcode = '23514';
     end if;
     if target_kind in ('credit_line', 'freeze') then
       if leg_count <> 1 then
         raise exception 'wallet audit transaction % must have exactly one zero leg', target_id using errcode = '23514';
       end if;
     elsif leg_count < 2 then
       raise exception 'wallet transaction % must have at least two legs', target_id using errcode = '23514';
     end if;
     return null;
   end $$`,
  `drop trigger if exists wallet_transactions_balance_ck on wallet_transactions`,
  `create constraint trigger wallet_transactions_balance_ck after insert on wallet_transactions
     deferrable initially deferred for each row execute function wallet_assert_transaction_balanced()`,
  `drop trigger if exists wallet_legs_balance_ck on wallet_legs`,
  `create constraint trigger wallet_legs_balance_ck after insert on wallet_legs
     deferrable initially deferred for each row execute function wallet_assert_transaction_balanced()`,
  `create or replace function wallet_assert_account_coherent() returns trigger language plpgsql as $$
   declare target_id uuid; account_kind varchar(8); stored_balance numeric(38,18); stored_in_flight numeric(38,18);
           stored_credit_limit numeric(38,18);
           last_balance numeric(38,18); active_total numeric(38,18);
   begin
     if tg_table_name = 'wallet_accounts' then
       target_id := case when tg_op = 'DELETE' then old.id else new.id end;
     else
       target_id := case when tg_op = 'DELETE' then old.account_id else new.account_id end;
     end if;
     select kind, balance, in_flight, credit_limit
       into account_kind, stored_balance, stored_in_flight, stored_credit_limit
       from wallet_accounts where id = target_id;
     if not found then return null; end if;
     select balance_after into last_balance from wallet_legs
       where account_id = target_id order by id desc limit 1;
     last_balance := coalesce(last_balance, 0);
     select coalesce(sum(amount), 0) into active_total from wallet_authorizations
       where account_id = target_id and status = 'active';
     if stored_balance <> last_balance then
       raise exception 'wallet account % balance differs from final leg', target_id using errcode = '23514';
     end if;
     if stored_in_flight <> active_total then
       raise exception 'wallet account % in_flight differs from active authorizations', target_id using errcode = '23514';
     end if;
     if account_kind = 'user' and stored_balance + stored_credit_limit - stored_in_flight < 0 then
       raise exception 'wallet account % available exposure is negative', target_id using errcode = '23514';
     end if;
     return null;
   end $$`,
  `drop trigger if exists wallet_accounts_coherence_ck on wallet_accounts`,
  `create constraint trigger wallet_accounts_coherence_ck after insert or update on wallet_accounts
     deferrable initially deferred for each row execute function wallet_assert_account_coherent()`,
  `drop trigger if exists wallet_legs_account_coherence_ck on wallet_legs`,
  `create constraint trigger wallet_legs_account_coherence_ck after insert on wallet_legs
     deferrable initially deferred for each row execute function wallet_assert_account_coherent()`,
  `drop trigger if exists wallet_authorizations_account_coherence_ck on wallet_authorizations`,
  `create constraint trigger wallet_authorizations_account_coherence_ck after insert or update or delete on wallet_authorizations
     deferrable initially deferred for each row execute function wallet_assert_account_coherent()`,
];

/** v3：稳定幂等命令指纹；历史行保留 NULL，由运行时兼容读取。 */
const WALLET_IDEMPOTENCY_DDL: readonly string[] = [
  `alter table wallet_transactions add column if not exists command_fingerprint varchar(64)`,
  `alter table wallet_authorizations add column if not exists authorize_fingerprint varchar(64)`,
  `alter table wallet_authorizations add column if not exists release_fingerprint varchar(64)`,
];

/** v4：内部科目逻辑名称不变，余额行按 shard 拆分以消除全局写热点。 */
const WALLET_INTERNAL_SHARDING_DDL: readonly string[] = [
  `alter table wallet_accounts add column if not exists shard integer not null default 0`,
  `do $$
   begin
     if not exists (
       select 1 from pg_constraint
       where conname = 'wallet_accounts_shard_ck'
         and conrelid = 'wallet_accounts'::regclass
     ) then
       alter table wallet_accounts add constraint wallet_accounts_shard_ck check (
         (kind = 'user' and shard = 0)
         or (kind = 'internal' and shard between 0 and 255)
       );
     end if;
   end $$`,
  `drop index if exists wallet_accounts_internal_uq`,
  `create unique index wallet_accounts_internal_uq
     on wallet_accounts (code, currency, shard) where kind = 'internal'`,
];

export interface WalletSchemaMigration {
  version: number;
  name: string;
  checksum: string;
  statements: readonly string[];
}

function migration(
  version: number,
  name: string,
  statements: readonly string[],
): WalletSchemaMigration {
  return {
    version,
    name,
    checksum: createHash('sha256').update(statements.join('\n')).digest('hex'),
    statements,
  };
}

/** 不可变、仅追加的版本化迁移清单。 */
export const walletSchemaMigrations: readonly WalletSchemaMigration[] = [
  migration(1, 'initial_double_entry_wallet', WALLET_DDL),
  migration(2, 'deferred_invariants_and_stable_receipts', WALLET_INVARIANT_DDL),
  migration(3, 'stable_command_fingerprints', WALLET_IDEMPOTENCY_DDL),
  migration(4, 'sharded_internal_accounts', WALLET_INTERNAL_SHARDING_DDL),
];

/** 串行、校验 checksum 的生产迁移入口。 */
export async function migrateWallet(db: NodePgDatabase): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(804204208)`);
    await tx.execute(sql`
      create table if not exists wallet_schema_migrations (
        version integer primary key,
        name varchar(128) not null,
        checksum varchar(64) not null,
        applied_at timestamptz not null default now()
      )
    `);
    const applied = await tx.execute(sql`
      select version, checksum from wallet_schema_migrations order by version
    `);
    const checksums = new Map(
      (applied.rows as Array<{ version: number; checksum: string }>).map((row) => [
        Number(row.version),
        row.checksum,
      ]),
    );
    for (const item of walletSchemaMigrations) {
      const existing = checksums.get(item.version);
      if (existing && existing !== item.checksum) {
        throw new Error(`wallet migration ${item.version} checksum mismatch`);
      }
      if (existing) continue;
      for (const statement of item.statements) await tx.execute(sql.raw(statement));
      await tx.execute(sql`
        insert into wallet_schema_migrations (version, name, checksum)
        values (${item.version}, ${item.name}, ${item.checksum})
      `);
    }
  });
}

/** 建表（幂等 IF NOT EXISTS）——消费方接入时执行一次；测试用 deprovision 清场 */
export async function provision(db: NodePgDatabase): Promise<void> {
  await migrateWallet(db);
}

/** 导出建表 DDL 文本：供消费方的版本化迁移工具（drizzle journal 等）收录 */
export function provisionSql(): readonly string[] {
  return walletSchemaMigrations.flatMap((item) => item.statements);
}

/** 测试清场：drop 四表（业务环境勿用） */
export async function deprovision(db: NodePgDatabase): Promise<void> {
  await db.execute(sql`drop table if exists wallet_legs`);
  await db.execute(sql`drop table if exists wallet_authorizations`);
  await db.execute(sql`drop table if exists wallet_transactions`);
  await db.execute(sql`drop table if exists wallet_accounts`);
  await db.execute(sql`drop table if exists wallet_schema_migrations`);
  await db.execute(sql`drop function if exists wallet_assert_account_coherent()`);
  await db.execute(sql`drop function if exists wallet_assert_transaction_balanced()`);
  await db.execute(sql`drop function if exists wallet_reject_ledger_mutation()`);
  await db.execute(sql`drop function if exists wallet_guard_leg_insert()`);
}
