CREATE TABLE "generation_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"api_key_id" bigint,
	"mapping_id" bigint NOT NULL,
	"channel_id" bigint NOT NULL,
	"upstream_task_id" varchar(128),
	"kind" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"params" jsonb NOT NULL,
	"receipt_template" jsonb NOT NULL,
	"units_snapshot" numeric(38, 18),
	"result" jsonb,
	"fail_reason" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "generation_tasks_kind_ck" CHECK ("generation_tasks"."kind" in ('video', 'music')),
	CONSTRAINT "generation_tasks_status_ck" CHECK ("generation_tasks"."status" in ('queued', 'running', 'succeeded', 'failed', 'expired')),
	CONSTRAINT "generation_tasks_terminal_state_ck" CHECK ((
        "generation_tasks"."status" = 'succeeded' and "generation_tasks"."result" is not null
      ) or (
        "generation_tasks"."status" in ('failed', 'expired') and "generation_tasks"."fail_reason" is not null
      ) or "generation_tasks"."status" in ('queued', 'running'))
);
--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_request_id_billing_requests_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."billing_requests"("request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_mapping_id_model_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."model_mappings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_tasks_status_created_idx" ON "generation_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "generation_tasks_user_created_idx" ON "generation_tasks" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "generation_tasks_channel_upstream_uq" ON "generation_tasks" USING btree ("channel_id","upstream_task_id");