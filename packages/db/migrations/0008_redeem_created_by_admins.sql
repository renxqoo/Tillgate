ALTER TABLE "redeem_batches" DROP CONSTRAINT "redeem_batches_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "redeem_batches" ADD CONSTRAINT "redeem_batches_created_by_admins_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;