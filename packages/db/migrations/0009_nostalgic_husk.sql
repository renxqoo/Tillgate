CREATE TABLE "billing_holds" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"status" varchar(16) DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_holds" ADD CONSTRAINT "billing_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_holds_user_status_idx" ON "billing_holds" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "billing_holds_status_created_idx" ON "billing_holds" USING btree ("status","created_at");