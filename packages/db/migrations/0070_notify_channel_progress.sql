-- 多渠道通知的逐渠道成功进度：部分失败重试时不得重复发送已成功渠道。
alter table "notify_outbox"
  add column if not exists "delivered_channel_ids" jsonb not null default '[]'::jsonb,
  add column if not exists "next_attempt_at" timestamptz not null default now();
--> statement-breakpoint
do $$ begin
  alter table "notify_outbox" add constraint "notify_outbox_delivered_channels_ck"
    check (jsonb_typeof("delivered_channel_ids") = 'array');
exception when duplicate_object then null;
end $$;
--> statement-breakpoint
drop index if exists "notify_outbox_pending_idx";
--> statement-breakpoint
create index if not exists "notify_outbox_pending_idx"
  on "notify_outbox" ("next_attempt_at", "claim_until", "id") where "sent_at" is null;
