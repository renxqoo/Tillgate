ALTER TABLE "billing_requests" ADD COLUMN "plan_reserved_amount" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "billing_requests" ADD COLUMN "subscription_id" bigint;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "reserved_amount" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_requests" ADD CONSTRAINT "billing_requests_subscription_id_user_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."user_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_subscription_ref_uq" ON "transactions" USING btree ("ref_type","ref_id") WHERE ref_type = 'subscription';--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_used_nonnegative_ck" CHECK ("user_subscriptions"."used_amount" >= 0);--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_reserved_nonnegative_ck" CHECK ("user_subscriptions"."reserved_amount" >= 0);--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_within_quota_ck" CHECK ("user_subscriptions"."used_amount" + "user_subscriptions"."reserved_amount" <= "user_subscriptions"."quota_amount");