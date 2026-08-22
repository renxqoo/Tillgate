CREATE TABLE "payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(16) NOT NULL,
	"provider_order_id" varchar(128) NOT NULL,
	"user_id" bigint NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"currency" varchar(8) DEFAULT 'CNY' NOT NULL,
	"credit_amount" numeric(38, 18) NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"credited_operation_id" varchar(128),
	"failure_reason" varchar(255),
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"credited_at" timestamp with time zone,
	CONSTRAINT "payment_orders_provider_ck" CHECK ("payment_orders"."provider" in ('epay','stripe')),
	CONSTRAINT "payment_orders_status_ck" CHECK ("payment_orders"."status" in (0, 1, 2, 3, 4)),
	CONSTRAINT "payment_orders_amounts_positive_ck" CHECK ("payment_orders"."amount" > 0 and "payment_orders"."credit_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"inviter_user_id" bigint NOT NULL,
	"invitee_user_id" bigint NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_self_invite_ck" CHECK ("referrals"."inviter_user_id" <> "referrals"."invitee_user_id"),
	CONSTRAINT "referrals_status_ck" CHECK ("referrals"."status" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"type" varchar(8) NOT NULL,
	"config" jsonb NOT NULL,
	"events" jsonb NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channels_type_ck" CHECK ("notification_channels"."type" in ('webhook','email')),
	CONSTRAINT "notification_channels_status_ck" CHECK ("notification_channels"."status" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE "notify_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event" varchar(32) NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" varchar(128) NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" varchar(255),
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_mappings" DROP CONSTRAINT "model_mappings_prices_nonnegative_ck";--> statement-breakpoint
ALTER TABLE "model_mappings" ADD COLUMN "pricing_unit" varchar(16) DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_mappings" ADD COLUMN "unit_price" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_mappings" ADD COLUMN "pricing_group" varchar(32);--> statement-breakpoint
ALTER TABLE "rate_card_coefficients" ADD COLUMN "group_key" varchar(32);--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "units" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "unit_price" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_credited_operation_id_fund_operations_operation_id_fk" FOREIGN KEY ("credited_operation_id") REFERENCES "public"."fund_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_inviter_user_id_users_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_invitee_user_id_users_id_fk" FOREIGN KEY ("invitee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_provider_order_uq" ON "payment_orders" USING btree ("provider","provider_order_id");--> statement-breakpoint
CREATE INDEX "payment_orders_user_created_idx" ON "payment_orders" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_orders_status_created_idx" ON "payment_orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_invitee_uq" ON "referrals" USING btree ("invitee_user_id");--> statement-breakpoint
CREATE INDEX "referrals_inviter_created_idx" ON "referrals" USING btree ("inviter_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_name_uq" ON "notification_channels" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "notify_outbox_dedupe_uq" ON "notify_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notify_outbox_pending_idx" ON "notify_outbox" USING btree ("id") WHERE sent_at is null;--> statement-breakpoint
CREATE INDEX "model_mappings_pricing_group_idx" ON "model_mappings" USING btree ("pricing_group");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_card_coefficients_group_uq" ON "rate_card_coefficients" USING btree ("rate_card_id","group_key") WHERE scope = 'group' and group_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_payment_ref_uq" ON "transactions" USING btree ("ref_type","ref_id") WHERE ref_type = 'payment_orders';--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_referral_commission_ref_uq" ON "transactions" USING btree ("ref_type","ref_id") WHERE ref_type = 'referral_commission';--> statement-breakpoint
ALTER TABLE "model_mappings" ADD CONSTRAINT "model_mappings_pricing_unit_ck" CHECK ("model_mappings"."pricing_unit" in ('token','request','image','second','char'));--> statement-breakpoint
ALTER TABLE "model_mappings" ADD CONSTRAINT "model_mappings_prices_nonnegative_ck" CHECK ("model_mappings"."input_price" >= 0 and "model_mappings"."output_price" >= 0 and "model_mappings"."cache_input_price" >= 0 and "model_mappings"."unit_price" >= 0);--> statement-breakpoint
ALTER TABLE "rate_card_coefficients" ADD CONSTRAINT "rate_card_coefficients_scope_ck" CHECK ("rate_card_coefficients"."scope" in ('global','model','group'));