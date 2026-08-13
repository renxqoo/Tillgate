CREATE TABLE "billing_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"reserved_amount" numeric(38, 18) NOT NULL,
	"status" varchar(32) DEFAULT 'authorized' NOT NULL,
	"stream" boolean DEFAULT false NOT NULL,
	"quote" jsonb NOT NULL,
	"authorization_fingerprint" varchar(64) NOT NULL,
	"receipt" jsonb,
	"receipt_fingerprint" varchar(64),
	"lease_owner" varchar(128),
	"lease_expires_at" timestamp with time zone,
	"upstream_started_at" timestamp with time zone,
	"failure_code" varchar(64),
	"settlement_attempts" bigint DEFAULT 0 NOT NULL,
	"next_settlement_at" timestamp with time zone,
	"last_error" text,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "billing_holds" CASCADE;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "calculated_amount" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "unbilled_overage" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_logs" DROP CONSTRAINT "usage_logs_app_id_apps_id_fk";--> statement-breakpoint
ALTER TABLE "usage_logs" DROP CONSTRAINT "usage_logs_api_key_id_api_keys_id_fk";--> statement-breakpoint
ALTER TABLE "usage_logs" DROP CONSTRAINT "usage_logs_channel_id_channels_id_fk";--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_requests" ADD CONSTRAINT "billing_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_requests_user_status_idx" ON "billing_requests" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "billing_requests_status_created_idx" ON "billing_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "billing_requests_pending_idx" ON "billing_requests" USING btree ("status","next_settlement_at");--> statement-breakpoint
CREATE INDEX "billing_requests_lease_idx" ON "billing_requests" USING btree ("status","lease_expires_at");
