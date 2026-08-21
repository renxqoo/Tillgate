CREATE TABLE "organizations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"owner_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role" varchar(16) DEFAULT 'member' NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"daily_spend_limit" numeric(38, 18),
	"monthly_quota" numeric(38, 18),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_invitations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"email" varchar(255) NOT NULL,
	"token" varchar(64) NOT NULL,
	"invited_by_user_id" bigint,
	"status" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "user_subscriptions_one_active_uq";--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "subscription_id" bigint;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "subscription_id" bigint;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "org_id" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_org_user_uq" ON "org_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "org_members_org_status_idx" ON "org_members" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "org_invitations_token_uq" ON "org_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "org_invitations_org_idx" ON "org_invitations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_invitations_email_idx" ON "org_invitations" USING btree ("email");--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_subscription_id_user_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."user_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_subscription_id_user_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."user_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apps_subscription_id_idx" ON "apps" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "api_keys_subscription_id_idx" ON "api_keys" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "user_subscriptions_org_idx" ON "user_subscriptions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_subscriptions_one_personal_uq" ON "user_subscriptions" USING btree ("user_id") WHERE "user_subscriptions"."status" = 0 and "user_subscriptions"."org_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_subscriptions_one_org_uq" ON "user_subscriptions" USING btree ("org_id") WHERE "user_subscriptions"."status" = 0 and "user_subscriptions"."org_id" is not null;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_billed_by_ck" CHECK ("usage_logs"."billed_by" in ('plan','payg'));