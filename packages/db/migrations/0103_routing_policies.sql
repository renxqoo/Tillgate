-- 智能路由策略热配置表（scope 唯一：global 单行 / mapping 覆写预留）。
-- policy JSONB 形状单一真相 = packages/inference routingPolicySchema。
-- 回滚：DROP TABLE IF EXISTS routing_policies;（热配置面无外部 FK 引用）
CREATE TABLE IF NOT EXISTS "routing_policies" (
  "id" bigserial PRIMARY KEY,
  "scope" varchar(64) NOT NULL,
  "version" varchar(32) NOT NULL,
  "policy" jsonb NOT NULL,
  "note" varchar(255),
  "updated_by" varchar(64),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "routing_policies_scope_uq" ON "routing_policies" ("scope");
