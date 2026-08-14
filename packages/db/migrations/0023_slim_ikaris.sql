ALTER TABLE "plans" ADD COLUMN "kind" varchar(16) DEFAULT 'subscription' NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "sort_order" bigint;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "quantity" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "price" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_quantity_positive_ck" CHECK ("user_subscriptions"."quantity" >= 1);--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_price_nonnegative_ck" CHECK ("user_subscriptions"."price" >= 0);