ALTER TABLE "users" DROP CONSTRAINT "users_balance_nonnegative_ck";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_reserved_not_over_balance_ck";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "credit_limit" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_balance_credit_floor_ck" CHECK ("users"."balance" >= -"users"."credit_limit");