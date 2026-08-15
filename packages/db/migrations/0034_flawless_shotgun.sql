ALTER TABLE "users" ADD COLUMN "session_invalid_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "session_invalid_before" timestamp with time zone;