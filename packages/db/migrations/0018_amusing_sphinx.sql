ALTER TABLE "api_keys" ADD COLUMN "daily_spend_limit" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "billing_requests" ADD COLUMN "api_key_id" bigint;--> statement-breakpoint
ALTER TABLE "billing_requests" ADD CONSTRAINT "billing_requests_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_requests_api_key_status_idx" ON "billing_requests" USING btree ("api_key_id","status");