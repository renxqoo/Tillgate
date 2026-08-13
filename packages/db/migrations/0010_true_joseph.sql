CREATE TABLE "fund_operations" (
	"operation_id" varchar(128) PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"transaction_id" bigint,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
