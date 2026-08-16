DROP INDEX IF EXISTS "user_subscriptions_one_personal_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_subscriptions_one_active_uq" ON "user_subscriptions" USING btree ("user_id") WHERE "user_subscriptions"."status" = 0;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_status_ck" CHECK ("users"."status" in (0, 1, 2));--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_status_ck" CHECK ("admins"."status" in (0, 1, 2));
