ALTER TABLE "channels" ADD COLUMN "upstream_reserved" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_requests" ADD COLUMN "channel_id" bigint;--> statement-breakpoint
ALTER TABLE "billing_requests" ADD COLUMN "channel_reserved_amount" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "billing_requests" ADD CONSTRAINT "billing_requests_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;