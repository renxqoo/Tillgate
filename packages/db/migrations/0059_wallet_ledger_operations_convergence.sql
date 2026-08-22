-- 0059：wallet 复式账本四表 + ledger_operations 幂等档案收敛进 db 迁移体系。
-- 全部语句幂等（IF NOT EXISTS / 条件加约束 / drop-then-create 触发器）：
--   - 已有环境（wallet 自管迁移 / ledger-core provision 建过表）执行 = 零操作；
--   - 全新环境从 journal 建库 = 五张表 + 提交期不变量触发器一次到位。
-- DDL 单一真源：packages/wallet/src/schema.ts provisionSql() + packages/ledger-core provisionSql()
-- （本文件由二者拼接生成；旧包自管迁移机制自此冻结，后续 DDL 变更只走本目录）。
create table if not exists wallet_accounts (id uuid primary key default gen_random_uuid(), kind varchar(8) not null, user_id bigint, code varchar(64), currency varchar(3) not null default 'CNY', balance numeric(38, 18) not null default 0, in_flight numeric(38, 18) not null default 0, credit_limit numeric(38, 18) not null default 0, status varchar(8) not null default 'active', updated_at timestamptz not null default now(), constraint wallet_accounts_identity_ck check ((kind = 'user' and user_id is not null and code is null) or (kind = 'internal' and code is not null and user_id is null)), constraint wallet_accounts_floor_ck check (credit_limit >= 0 and in_flight >= 0), constraint wallet_accounts_balance_floor_ck check (kind = 'internal' or balance >= -credit_limit), constraint wallet_accounts_status_ck check (status in ('active', 'frozen')))
--> statement-breakpoint
create unique index if not exists wallet_accounts_user_uq on wallet_accounts (user_id, currency) where kind = 'user'
--> statement-breakpoint
create unique index if not exists wallet_accounts_internal_uq on wallet_accounts (code, currency) where kind = 'internal'
--> statement-breakpoint
create table if not exists wallet_transactions (id bigserial primary key, kind varchar(16) not null, ref_type varchar(32) not null, ref_id varchar(128) not null, memo varchar(255), credit_limit_after numeric(38, 18), frozen_after boolean, created_at timestamptz not null default now(), constraint wallet_transactions_ref_kind_uq unique (ref_type, ref_id, kind), constraint wallet_transactions_kind_ck check (kind in ('credit', 'settle', 'refund', 'transfer', 'credit_line', 'freeze')))
--> statement-breakpoint
create index if not exists wallet_transactions_ref_idx on wallet_transactions (ref_type, created_at)
--> statement-breakpoint
create table if not exists wallet_legs (id bigserial primary key, transaction_id bigint not null references wallet_transactions (id), account_id uuid not null references wallet_accounts (id), currency varchar(3) not null, amount numeric(38, 18) not null, balance_before numeric(38, 18) not null, balance_after numeric(38, 18) not null, constraint wallet_legs_chain_ck check (balance_after = balance_before + amount))
--> statement-breakpoint
create index if not exists wallet_legs_account_idx on wallet_legs (account_id, id)
--> statement-breakpoint
create index if not exists wallet_legs_transaction_idx on wallet_legs (transaction_id)
--> statement-breakpoint
create table if not exists wallet_authorizations (id uuid primary key default gen_random_uuid(), account_id uuid not null references wallet_accounts (id), ref_type varchar(32) not null, ref_id varchar(128) not null, amount numeric(38, 18) not null, status varchar(16) not null default 'active', settled_amount numeric(38, 18), release_reason varchar(64), memo varchar(255), expires_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), constraint wallet_authorizations_ref_uq unique (ref_type, ref_id), constraint wallet_authorizations_amount_ck check (amount > 0), constraint wallet_authorizations_status_ck check (status in ('active', 'settled', 'released', 'expired')))
--> statement-breakpoint
create index if not exists wallet_authorizations_expiry_idx on wallet_authorizations (expires_at) where status = 'active' and expires_at is not null
--> statement-breakpoint
alter table wallet_transactions add column if not exists frozen_after boolean
--> statement-breakpoint
alter table wallet_authorizations add column if not exists memo varchar(255)
--> statement-breakpoint
create index if not exists wallet_authorizations_account_active_idx on wallet_authorizations (account_id) where status = 'active'
--> statement-breakpoint
create index if not exists wallet_legs_account_transaction_idx on wallet_legs (account_id, transaction_id desc)
--> statement-breakpoint
do $$ begin if not exists (select 1 from pg_constraint where conname = 'wallet_transactions_receipt_ck' and conrelid = 'wallet_transactions'::regclass) then alter table wallet_transactions add constraint wallet_transactions_receipt_ck check ((kind = 'freeze' and frozen_after is not null and credit_limit_after is null) or (kind = 'credit_line' and frozen_after is null and credit_limit_after is not null) or (kind not in ('freeze', 'credit_line') and frozen_after is null and credit_limit_after is null)); end if; if not exists (select 1 from pg_constraint where conname = 'wallet_authorizations_state_ck' and conrelid = 'wallet_authorizations'::regclass) then alter table wallet_authorizations add constraint wallet_authorizations_state_ck check ((status = 'active' and settled_amount is null and release_reason is null) or (status = 'settled' and settled_amount > 0 and settled_amount <= amount and release_reason is null) or (status in ('released', 'expired') and settled_amount is null and release_reason is not null)); end if; end $$
--> statement-breakpoint
create or replace function wallet_guard_leg_insert() returns trigger language plpgsql as $$ declare current_balance numeric(38,18); account_currency varchar(3); begin select balance, currency into current_balance, account_currency from wallet_accounts where id = new.account_id for update; if not found then raise exception 'wallet leg account % missing', new.account_id using errcode = '23514'; end if; if account_currency <> new.currency then raise exception 'wallet leg currency % differs from account currency %', new.currency, account_currency using errcode = '23514'; end if; if current_balance <> new.balance_before then raise exception 'wallet leg chain is not continuous for account %', new.account_id using errcode = '23514'; end if; return new; end $$
--> statement-breakpoint
drop trigger if exists wallet_legs_insert_guard on wallet_legs
--> statement-breakpoint
create trigger wallet_legs_insert_guard before insert on wallet_legs for each row execute function wallet_guard_leg_insert()
--> statement-breakpoint
create or replace function wallet_reject_ledger_mutation() returns trigger language plpgsql as $$ begin raise exception 'wallet ledger rows are immutable' using errcode = '23514'; end $$
--> statement-breakpoint
drop trigger if exists wallet_legs_immutable on wallet_legs
--> statement-breakpoint
create trigger wallet_legs_immutable before update or delete on wallet_legs for each row execute function wallet_reject_ledger_mutation()
--> statement-breakpoint
drop trigger if exists wallet_transactions_immutable on wallet_transactions
--> statement-breakpoint
create trigger wallet_transactions_immutable before update or delete on wallet_transactions for each row execute function wallet_reject_ledger_mutation()
--> statement-breakpoint
create or replace function wallet_assert_transaction_balanced() returns trigger language plpgsql as $$ declare target_id bigint; target_kind varchar(16); leg_count bigint; total numeric(38,18); begin if tg_table_name = 'wallet_transactions' then target_id := new.id; else target_id := new.transaction_id; end if; select kind into target_kind from wallet_transactions where id = target_id; if not found then return null; end if; select count(*), coalesce(sum(amount), 0) into leg_count, total from wallet_legs where transaction_id = target_id; if total <> 0 then raise exception 'wallet transaction % is unbalanced: %', target_id, total using errcode = '23514'; end if; if target_kind in ('credit_line', 'freeze') then if leg_count <> 1 then raise exception 'wallet audit transaction % must have exactly one zero leg', target_id using errcode = '23514'; end if; elsif leg_count < 2 then raise exception 'wallet transaction % must have at least two legs', target_id using errcode = '23514'; end if; return null; end $$
--> statement-breakpoint
drop trigger if exists wallet_transactions_balance_ck on wallet_transactions
--> statement-breakpoint
create constraint trigger wallet_transactions_balance_ck after insert on wallet_transactions deferrable initially deferred for each row execute function wallet_assert_transaction_balanced()
--> statement-breakpoint
drop trigger if exists wallet_legs_balance_ck on wallet_legs
--> statement-breakpoint
create constraint trigger wallet_legs_balance_ck after insert on wallet_legs deferrable initially deferred for each row execute function wallet_assert_transaction_balanced()
--> statement-breakpoint
create or replace function wallet_assert_account_coherent() returns trigger language plpgsql as $$ declare target_id uuid; account_kind varchar(8); stored_balance numeric(38,18); stored_in_flight numeric(38,18); stored_credit_limit numeric(38,18); last_balance numeric(38,18); active_total numeric(38,18); begin if tg_table_name = 'wallet_accounts' then target_id := case when tg_op = 'DELETE' then old.id else new.id end; else target_id := case when tg_op = 'DELETE' then old.account_id else new.account_id end; end if; select kind, balance, in_flight, credit_limit into account_kind, stored_balance, stored_in_flight, stored_credit_limit from wallet_accounts where id = target_id; if not found then return null; end if; select balance_after into last_balance from wallet_legs where account_id = target_id order by id desc limit 1; last_balance := coalesce(last_balance, 0); select coalesce(sum(amount), 0) into active_total from wallet_authorizations where account_id = target_id and status = 'active'; if stored_balance <> last_balance then raise exception 'wallet account % balance differs from final leg', target_id using errcode = '23514'; end if; if stored_in_flight <> active_total then raise exception 'wallet account % in_flight differs from active authorizations', target_id using errcode = '23514'; end if; if account_kind = 'user' and stored_balance + stored_credit_limit - stored_in_flight < 0 then raise exception 'wallet account % available exposure is negative', target_id using errcode = '23514'; end if; return null; end $$
--> statement-breakpoint
drop trigger if exists wallet_accounts_coherence_ck on wallet_accounts
--> statement-breakpoint
create constraint trigger wallet_accounts_coherence_ck after insert or update on wallet_accounts deferrable initially deferred for each row execute function wallet_assert_account_coherent()
--> statement-breakpoint
drop trigger if exists wallet_legs_account_coherence_ck on wallet_legs
--> statement-breakpoint
create constraint trigger wallet_legs_account_coherence_ck after insert on wallet_legs deferrable initially deferred for each row execute function wallet_assert_account_coherent()
--> statement-breakpoint
drop trigger if exists wallet_authorizations_account_coherence_ck on wallet_authorizations
--> statement-breakpoint
create constraint trigger wallet_authorizations_account_coherence_ck after insert or update or delete on wallet_authorizations deferrable initially deferred for each row execute function wallet_assert_account_coherent()
--> statement-breakpoint
alter table wallet_transactions add column if not exists command_fingerprint varchar(64)
--> statement-breakpoint
alter table wallet_authorizations add column if not exists authorize_fingerprint varchar(64)
--> statement-breakpoint
alter table wallet_authorizations add column if not exists release_fingerprint varchar(64)
--> statement-breakpoint
alter table wallet_accounts add column if not exists shard integer not null default 0
--> statement-breakpoint
do $$ begin if not exists (select 1 from pg_constraint where conname = 'wallet_accounts_shard_ck' and conrelid = 'wallet_accounts'::regclass) then alter table wallet_accounts add constraint wallet_accounts_shard_ck check ((kind = 'user' and shard = 0) or (kind = 'internal' and shard between 0 and 255)); end if; end $$
--> statement-breakpoint
drop index if exists wallet_accounts_internal_uq
--> statement-breakpoint
create unique index wallet_accounts_internal_uq on wallet_accounts (code, currency, shard) where kind = 'internal'
--> statement-breakpoint
create table if not exists ledger_operations (id bigserial primary key, operation_id varchar(128) not null, kind varchar(32) not null, fingerprint varchar(64) not null, receipt jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), constraint ledger_operations_operation_id_uq unique (operation_id))
--> statement-breakpoint
create index if not exists ledger_operations_kind_id_idx on ledger_operations (kind, id)
