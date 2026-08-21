-- 0060：资金来源预扣明细表（billing_reservations）+ 包月转按量开关（api_keys）。
-- billing_reservations 是瀑布预占的真相表——billing_requests 三列
-- （reserved_amount / plan_reserved_amount / subscription_id）自此成为投影；
-- 释放/结算按明细逐笔走对应来源，任何一处遗漏 = 永久冻结。
-- allow_payg_fallback 默认 false：存量套餐 Key 零行为变化（额度不足仍整单拒绝）。
create table if not exists billing_reservations (id bigserial primary key, billing_request_id uuid not null references billing_requests(request_id), source_type varchar(32) not null, source_ref_id bigint, amount numeric(38, 18) not null, status varchar(16) not null default 'active', released_at timestamptz, settled_at timestamptz, created_at timestamptz not null default now(), constraint billing_reservations_amount_positive check (amount > 0), constraint billing_reservations_status_valid check (status in ('active', 'released', 'settled')), constraint billing_reservations_status_ts check ((status = 'active' and released_at is null and settled_at is null) or (status = 'released' and released_at is not null and settled_at is null) or (status = 'settled' and settled_at is not null and released_at is null)))
--> statement-breakpoint
create index if not exists billing_reservations_request_idx on billing_reservations (billing_request_id) where status = 'active'
--> statement-breakpoint
create index if not exists billing_reservations_source_idx on billing_reservations (source_type, source_ref_id) where status = 'active'
--> statement-breakpoint
create index if not exists billing_reservations_request_all_idx on billing_reservations (billing_request_id)
--> statement-breakpoint
create unique index if not exists billing_reservations_request_source_uq on billing_reservations (billing_request_id, source_type) where status = 'active'
--> statement-breakpoint
alter table api_keys add column if not exists allow_payg_fallback boolean not null default false
