-- 金额系统重构：厘(bigint) → 元(numeric(38,18) 全精度)
--
-- 破坏性数据迁移：所有金额列 bigint → numeric(38,18)，同时数值除以 1000（厘→元）。
-- coefficient 列已是 numeric(6,3) 不变；token 计数列（input_tokens 等）保持 bigint。
-- 新增 reconcile_discrepancies 表（对账差异记录）。
--
-- 迁移幂等性：每条 ALTER 用 IF EXISTS 保护列；USING col::numeric / 1000 完成单位换算。

-- users.balance
ALTER TABLE "users" ALTER COLUMN "balance" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "balance" TYPE numeric(38,18) USING "balance"::numeric / 1000;
ALTER TABLE "users" ALTER COLUMN "balance" SET DEFAULT '0';
--> statement-breakpoint

-- model_mappings 价格（厘/百万 → 元/百万）
ALTER TABLE "model_mappings" ALTER COLUMN "input_price" DROP DEFAULT;
ALTER TABLE "model_mappings" ALTER COLUMN "input_price" TYPE numeric(38,18) USING "input_price"::numeric / 1000;
ALTER TABLE "model_mappings" ALTER COLUMN "input_price" SET DEFAULT '0';
ALTER TABLE "model_mappings" ALTER COLUMN "output_price" DROP DEFAULT;
ALTER TABLE "model_mappings" ALTER COLUMN "output_price" TYPE numeric(38,18) USING "output_price"::numeric / 1000;
ALTER TABLE "model_mappings" ALTER COLUMN "output_price" SET DEFAULT '0';
ALTER TABLE "model_mappings" ALTER COLUMN "cache_input_price" DROP DEFAULT;
ALTER TABLE "model_mappings" ALTER COLUMN "cache_input_price" TYPE numeric(38,18) USING "cache_input_price"::numeric / 1000;
ALTER TABLE "model_mappings" ALTER COLUMN "cache_input_price" SET DEFAULT '0';
--> statement-breakpoint

-- usage_logs 价格快照 + 费用（coefficient 不变）
ALTER TABLE "usage_logs" ALTER COLUMN "input_price" DROP DEFAULT;
ALTER TABLE "usage_logs" ALTER COLUMN "input_price" TYPE numeric(38,18) USING "input_price"::numeric / 1000;
ALTER TABLE "usage_logs" ALTER COLUMN "input_price" SET DEFAULT '0';
ALTER TABLE "usage_logs" ALTER COLUMN "output_price" DROP DEFAULT;
ALTER TABLE "usage_logs" ALTER COLUMN "output_price" TYPE numeric(38,18) USING "output_price"::numeric / 1000;
ALTER TABLE "usage_logs" ALTER COLUMN "output_price" SET DEFAULT '0';
ALTER TABLE "usage_logs" ALTER COLUMN "cache_input_price" DROP DEFAULT;
ALTER TABLE "usage_logs" ALTER COLUMN "cache_input_price" TYPE numeric(38,18) USING "cache_input_price"::numeric / 1000;
ALTER TABLE "usage_logs" ALTER COLUMN "cache_input_price" SET DEFAULT '0';
ALTER TABLE "usage_logs" ALTER COLUMN "amount" DROP DEFAULT;
ALTER TABLE "usage_logs" ALTER COLUMN "amount" TYPE numeric(38,18) USING "amount"::numeric / 1000;
ALTER TABLE "usage_logs" ALTER COLUMN "amount" SET DEFAULT '0';
ALTER TABLE "usage_logs" ALTER COLUMN "upstream_cost" DROP DEFAULT;
ALTER TABLE "usage_logs" ALTER COLUMN "upstream_cost" TYPE numeric(38,18) USING "upstream_cost"::numeric / 1000;
ALTER TABLE "usage_logs" ALTER COLUMN "upstream_cost" SET DEFAULT '0';
ALTER TABLE "usage_logs" ALTER COLUMN "plan_amount" DROP DEFAULT;
ALTER TABLE "usage_logs" ALTER COLUMN "plan_amount" TYPE numeric(38,18) USING "plan_amount"::numeric / 1000;
ALTER TABLE "usage_logs" ALTER COLUMN "plan_amount" SET DEFAULT '0';
ALTER TABLE "usage_logs" ALTER COLUMN "payg_amount" DROP DEFAULT;
ALTER TABLE "usage_logs" ALTER COLUMN "payg_amount" TYPE numeric(38,18) USING "payg_amount"::numeric / 1000;
ALTER TABLE "usage_logs" ALTER COLUMN "payg_amount" SET DEFAULT '0';
--> statement-breakpoint

-- transactions 流水（amount/balance_before/balance_after）
ALTER TABLE "transactions" ALTER COLUMN "amount" TYPE numeric(38,18) USING "amount"::numeric / 1000;
ALTER TABLE "transactions" ALTER COLUMN "balance_before" TYPE numeric(38,18) USING "balance_before"::numeric / 1000;
ALTER TABLE "transactions" ALTER COLUMN "balance_after" TYPE numeric(38,18) USING "balance_after"::numeric / 1000;
--> statement-breakpoint

-- redeem_batches 面额
ALTER TABLE "redeem_batches" ALTER COLUMN "amount" TYPE numeric(38,18) USING "amount"::numeric / 1000;
--> statement-breakpoint

-- plans 售价 + 额度
ALTER TABLE "plans" ALTER COLUMN "price" TYPE numeric(38,18) USING "price"::numeric / 1000;
ALTER TABLE "plans" ALTER COLUMN "quota_amount" TYPE numeric(38,18) USING "quota_amount"::numeric / 1000;
--> statement-breakpoint

-- user_subscriptions 额度快照 + 已用
ALTER TABLE "user_subscriptions" ALTER COLUMN "quota_amount" TYPE numeric(38,18) USING "quota_amount"::numeric / 1000;
ALTER TABLE "user_subscriptions" ALTER COLUMN "used_amount" DROP DEFAULT;
ALTER TABLE "user_subscriptions" ALTER COLUMN "used_amount" TYPE numeric(38,18) USING "used_amount"::numeric / 1000;
ALTER TABLE "user_subscriptions" ALTER COLUMN "used_amount" SET DEFAULT '0';
--> statement-breakpoint

-- 新增对账差异表
CREATE TABLE IF NOT EXISTS "reconcile_discrepancies" (
	"id" bigserial PRIMARY KEY,
	"scope" varchar(16) NOT NULL,
	"user_id" bigint,
	"expected" numeric(38,18) NOT NULL,
	"actual" numeric(38,18) NOT NULL,
	"diff" numeric(38,18) NOT NULL,
	"detail" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconcile_user_created_idx" ON "reconcile_discrepancies" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconcile_scope_created_idx" ON "reconcile_discrepancies" USING btree ("scope","created_at");
--> statement-breakpoint
ALTER TABLE "reconcile_discrepancies" ADD CONSTRAINT "reconcile_discrepancies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
