CREATE TABLE "channel_recharges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" bigint NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"remark" varchar(255),
	"admin_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "upstream_budget" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "upstream_threshold" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "channel_recharges" ADD CONSTRAINT "channel_recharges_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_recharges" ADD CONSTRAINT "channel_recharges_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_recharges_channel_created_idx" ON "channel_recharges" USING btree ("channel_id","created_at");