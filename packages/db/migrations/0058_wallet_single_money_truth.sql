-- wallet 单一资金事实源。
-- 前置：开账迁移已完成且相等性门禁通过（packages/ledger/scripts/migrate-opening.ts，
--   逐用户 wallet 余额 == users.balance 全等才允许执行本迁移）。
-- 退役对象：
--   users.balance / reserved_balance / credit_limit —— 资金事实移至 wallet_accounts
--     （balance/credit_limit 列）与 wallet_authorizations（在途）；
--   fund_operations —— 由 ledger_operations 承担（0056 已回填）。
-- 封存（不 DROP）：旧 transactions 表——报表按需直读，需求明确后再删。
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_balance_credit_floor_ck";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_reserved_balance_nonnegative_ck";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "balance";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "reserved_balance";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "credit_limit";
--> statement-breakpoint
DROP TABLE IF EXISTS "fund_operations";
