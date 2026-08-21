ALTER TABLE "users" ADD COLUMN "reserved_balance" numeric(38, 18) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- 旧 balance 已经扣除了活跃请求预留。迁移为 posted/reserved 双字段时，
-- 把活跃预留加回 posted，确保 available = posted - reserved 与迁移前完全相同。
WITH active_reservations AS (
  SELECT user_id, COALESCE(SUM(reserved_amount), 0)::numeric(38,18) AS amount
  FROM billing_requests
  WHERE status IN ('authorized','in_flight','settlement_pending','processing','retry_wait','uncertain','dead')
  GROUP BY user_id
)
UPDATE users u
SET reserved_balance = a.amount,
    balance = u.balance + a.amount,
    updated_at = clock_timestamp()
FROM active_reservations a
WHERE u.id = a.user_id;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_balance_nonnegative_ck" CHECK ("users"."balance" >= 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_reserved_balance_nonnegative_ck" CHECK ("users"."reserved_balance" >= 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_reserved_not_over_balance_ck" CHECK ("users"."reserved_balance" <= "users"."balance");
