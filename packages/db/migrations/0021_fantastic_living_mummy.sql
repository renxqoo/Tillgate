ALTER TABLE "channel_recharges" ADD COLUMN "type" varchar(16) DEFAULT 'recharge' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_recharges" ADD COLUMN "balance_after" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_recharges" ADD COLUMN "order_no" varchar(128);--> statement-breakpoint
ALTER TABLE "channel_recharges" ADD COLUMN "voucher" varchar(128);