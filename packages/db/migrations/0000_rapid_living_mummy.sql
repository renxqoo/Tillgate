CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"issuer" varchar(64) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"identity_provider" varchar(16) NOT NULL,
	"email" varchar(255),
	"display_name" varchar(64),
	"role" smallint DEFAULT 0 NOT NULL,
	"rate_card_id" bigint,
	"balance" bigint DEFAULT 0 NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"freeze_reason" varchar(128),
	"rpm_limit" bigint,
	"tpm_limit" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"app_id" varchar(32) NOT NULL,
	"user_id" bigint NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"client_secret_hash" varchar(64) NOT NULL,
	"name" varchar(64) NOT NULL,
	"description" varchar(255),
	"scope" jsonb,
	"status" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"key_preview" varchar(40) NOT NULL,
	"user_id" bigint NOT NULL,
	"app_id" bigint,
	"name" varchar(64) NOT NULL,
	"remark" varchar(255),
	"expires_at" timestamp with time zone,
	"rpm_limit" bigint,
	"tpm_limit" bigint,
	"status" smallint DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(32) NOT NULL,
	"protocol" varchar(32) DEFAULT 'openai_compatible' NOT NULL,
	"base_url" varchar(255) NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider_id" bigint NOT NULL,
	"name" varchar(64) NOT NULL,
	"api_key_enc" text NOT NULL,
	"base_url_override" varchar(255),
	"models" jsonb,
	"weight" bigint DEFAULT 1 NOT NULL,
	"priority" bigint DEFAULT 0 NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"fail_count" bigint DEFAULT 0 NOT NULL,
	"cooldown_until" timestamp with time zone,
	"rpm_limit" bigint,
	"tpm_limit" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_channels" (
	"mapping_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"weight" bigint DEFAULT 1 NOT NULL,
	"priority" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_mappings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"external_name" varchar(64) NOT NULL,
	"real_model" varchar(128) NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"input_price" bigint DEFAULT 0 NOT NULL,
	"output_price" bigint DEFAULT 0 NOT NULL,
	"cache_input_price" bigint DEFAULT 0 NOT NULL,
	"fallback_models" jsonb,
	"param_rules" jsonb,
	"rpm_limit" bigint,
	"tpm_limit" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_card_coefficients" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rate_card_id" bigint NOT NULL,
	"scope" varchar(8) NOT NULL,
	"model_mapping_id" bigint,
	"coefficient" numeric(6, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_cards" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(32) NOT NULL,
	"description" varchar(255),
	"status" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"app_id" bigint,
	"api_key_id" bigint,
	"credential_type" varchar(8) NOT NULL,
	"external_model" varchar(64) NOT NULL,
	"real_model" varchar(128) NOT NULL,
	"channel_id" bigint,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"tokens_estimated" boolean DEFAULT false NOT NULL,
	"input_price" bigint DEFAULT 0 NOT NULL,
	"output_price" bigint DEFAULT 0 NOT NULL,
	"cache_input_price" bigint DEFAULT 0 NOT NULL,
	"coefficient" numeric(6, 3) NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"upstream_cost" bigint DEFAULT 0 NOT NULL,
	"plan_amount" bigint DEFAULT 0 NOT NULL,
	"payg_amount" bigint DEFAULT 0 NOT NULL,
	"billed_by" varchar(8) NOT NULL,
	"subscription_id" bigint,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"stream" boolean DEFAULT false NOT NULL,
	"stream_aborted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"type" varchar(16) NOT NULL,
	"amount" bigint NOT NULL,
	"balance_before" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"ref_type" varchar(32),
	"ref_id" varchar(64),
	"remark" varchar(255),
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redeem_batches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"remark" varchar(255),
	"amount" bigint NOT NULL,
	"total" bigint NOT NULL,
	"used_count" bigint DEFAULT 0 NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redeem_codes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"batch_id" bigint NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"used_by" bigint,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"admin_id" bigint,
	"actor" varchar(8) DEFAULT 'admin' NOT NULL,
	"action" varchar(64) NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" varchar(64),
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" bigint,
	"api_key_id" bigint,
	"method" varchar(8) NOT NULL,
	"path" varchar(128) NOT NULL,
	"status_code" bigint NOT NULL,
	"error_code" varchar(32),
	"duration_ms" bigint NOT NULL,
	"request_summary" jsonb,
	"attempts" bigint DEFAULT 1 NOT NULL,
	"candidates_tried" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(32) NOT NULL,
	"price" bigint NOT NULL,
	"period_days" bigint NOT NULL,
	"quota_amount" bigint NOT NULL,
	"fallback_to_balance" boolean DEFAULT true NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_subscriptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"plan_id" bigint NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"quota_amount" bigint NOT NULL,
	"used_amount" bigint DEFAULT 0 NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_rate_card_id_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."rate_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_channels" ADD CONSTRAINT "model_channels_mapping_id_model_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."model_mappings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_channels" ADD CONSTRAINT "model_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_card_coefficients" ADD CONSTRAINT "rate_card_coefficients_rate_card_id_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."rate_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_card_coefficients" ADD CONSTRAINT "rate_card_coefficients_model_mapping_id_model_mappings_id_fk" FOREIGN KEY ("model_mapping_id") REFERENCES "public"."model_mappings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_subscription_id_user_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."user_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_batches" ADD CONSTRAINT "redeem_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_codes" ADD CONSTRAINT "redeem_codes_batch_id_redeem_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."redeem_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_codes" ADD CONSTRAINT "redeem_codes_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_issuer_subject_uq" ON "users" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "users_rate_card_id_idx" ON "users" USING btree ("rate_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_app_id_uq" ON "apps" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_client_id_uq" ON "apps" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "apps_user_id_idx" ON "apps" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_keys_app_id_idx" ON "api_keys" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "providers_name_uq" ON "providers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "channels_provider_id_idx" ON "channels" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "model_channels_channel_id_idx" ON "model_channels" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_mappings_external_name_uq" ON "model_mappings" USING btree ("external_name");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_card_coefficients_uq" ON "rate_card_coefficients" USING btree ("rate_card_id","scope","model_mapping_id");--> statement-breakpoint
CREATE INDEX "rate_card_coefficients_mapping_idx" ON "rate_card_coefficients" USING btree ("model_mapping_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_cards_name_uq" ON "rate_cards" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_logs_request_id_uq" ON "usage_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "usage_logs_user_created_idx" ON "usage_logs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_logs_model_created_idx" ON "usage_logs" USING btree ("external_model","created_at");--> statement-breakpoint
CREATE INDEX "usage_logs_channel_created_idx" ON "usage_logs" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_logs_subscription_idx" ON "usage_logs" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_user_created_idx" ON "transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "transactions_type_created_idx" ON "transactions" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "transactions_ref_idx" ON "transactions" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "redeem_batches_created_by_idx" ON "redeem_batches" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "redeem_codes_code_hash_uq" ON "redeem_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "redeem_codes_batch_idx" ON "redeem_codes" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "redeem_codes_used_by_idx" ON "redeem_codes" USING btree ("used_by");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "request_logs_created_idx" ON "request_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "request_logs_user_created_idx" ON "request_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "plans_name_idx" ON "plans" USING btree ("name");--> statement-breakpoint
CREATE INDEX "user_subscriptions_user_idx" ON "user_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_subscriptions_plan_idx" ON "user_subscriptions" USING btree ("plan_id");