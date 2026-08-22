-- notify_outbox 多副本消费租约：先原子认领再执行 webhook/email，避免并发重复投递。
alter table "notify_outbox"
  add column if not exists "claim_owner" varchar(128),
  add column if not exists "claim_token" uuid,
  add column if not exists "claim_until" timestamptz;
--> statement-breakpoint
drop index if exists "notify_outbox_pending_idx";
--> statement-breakpoint
create index if not exists "notify_outbox_pending_idx"
  on "notify_outbox" ("claim_until", "id") where "sent_at" is null;
--> statement-breakpoint
do $$ begin
  alter table "notify_outbox" add constraint "notify_outbox_claim_ck" check (
    ("claim_owner" is null and "claim_token" is null and "claim_until" is null)
    or
    ("sent_at" is null and "claim_owner" is not null and "claim_token" is not null and "claim_until" is not null)
  );
exception when duplicate_object then null;
end $$;
