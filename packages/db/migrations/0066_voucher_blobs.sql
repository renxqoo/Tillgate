-- 0066：渠道进货凭证入库存——多副本安全（原本地磁盘 ./data/vouchers 在第二副本起即互不可见，
--   且容器重建即丢凭证）。凭证为小图（≤2MB 白名单 PNG/JPEG/WebP/GIF），bytea 直存：
--   运营查凭证是低频回看，不值引入对象存储的运维面；键 = uuid.ext 与既有 channel_recharges.voucher 列兼容。
create table if not exists "voucher_blobs" (
  "key" varchar(48) primary key,
  "mime" varchar(32) not null,
  "data" bytea not null,
  "created_at" timestamptz not null default now()
);
--> statement-breakpoint--
create index if not exists "voucher_blobs_created_at_idx" on "voucher_blobs" ("created_at" desc);
