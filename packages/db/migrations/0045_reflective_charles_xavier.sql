CREATE TABLE "token_estimate_calibration" (
	"id" smallint PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "token_estimate_samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"provider_name" varchar(32) NOT NULL,
	"model" varchar(128) NOT NULL,
	"input_cjk_chars" bigint DEFAULT 0 NOT NULL,
	"input_word_segments" bigint DEFAULT 0 NOT NULL,
	"input_number_segments" bigint DEFAULT 0 NOT NULL,
	"input_symbol_count" bigint DEFAULT 0 NOT NULL,
	"input_media_parts" bigint DEFAULT 0 NOT NULL,
	"output_cjk_chars" bigint DEFAULT 0 NOT NULL,
	"output_word_segments" bigint DEFAULT 0 NOT NULL,
	"output_number_segments" bigint DEFAULT 0 NOT NULL,
	"output_symbol_count" bigint DEFAULT 0 NOT NULL,
	"estimated_input_tokens" bigint DEFAULT 0 NOT NULL,
	"estimated_output_tokens" bigint DEFAULT 0 NOT NULL,
	"actual_input_tokens" bigint,
	"actual_output_tokens" bigint,
	"actual_cached_input_tokens" bigint,
	"calibration_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "token_estimate_samples_request_id_uq" ON "token_estimate_samples" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "token_estimate_samples_provider_model_created_idx" ON "token_estimate_samples" USING btree ("provider_name","model","created_at");