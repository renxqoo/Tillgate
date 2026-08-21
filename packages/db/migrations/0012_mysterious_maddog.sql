ALTER TABLE "billing_requests" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_requests" ADD COLUMN "claim_owner" varchar(128);--> statement-breakpoint
ALTER TABLE "billing_requests" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "billing_requests" ADD COLUMN "claim_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_requests" ADD COLUMN "failure_class" varchar(64);--> statement-breakpoint
ALTER TABLE "billing_requests" ADD COLUMN "dead_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "billing_requests_claim_idx" ON "billing_requests" USING btree ("status","claim_until");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_requests_claim_token_uq" ON "billing_requests" USING btree ("claim_token");--> statement-breakpoint
ALTER TABLE "billing_requests" ADD CONSTRAINT "billing_requests_status_ck" CHECK ("billing_requests"."status" in ('authorized','in_flight','settlement_pending','processing','retry_wait','settled','released','uncertain','dead'));--> statement-breakpoint
ALTER TABLE "billing_requests" ADD CONSTRAINT "billing_requests_receipt_state_ck" CHECK (("billing_requests"."status" not in ('settlement_pending','processing','retry_wait','settled','dead')) or "billing_requests"."receipt" is not null);--> statement-breakpoint
ALTER TABLE "billing_requests" ADD CONSTRAINT "billing_requests_claim_state_ck" CHECK (("billing_requests"."status" = 'processing') = ("billing_requests"."claim_token" is not null and "billing_requests"."claim_owner" is not null and "billing_requests"."claim_until" is not null));