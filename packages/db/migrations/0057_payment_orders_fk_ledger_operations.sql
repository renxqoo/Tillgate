-- 入账幂等锚点外键改指 ledger_operations（幂等档案迁移，见 0056）。
-- 前置：0056 已把存量 fund_operations 回填进 ledger_operations——既有
-- credited_operation_id 值在新引用表中全部存在，ADD CONSTRAINT 校验可过。
ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_credited_operation_id_fund_operations_operation_";
--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_credited_operation_id_ledger_operations_operation_f" FOREIGN KEY ("credited_operation_id") REFERENCES "ledger_operations"("operation_id");
