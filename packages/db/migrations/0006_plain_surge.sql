-- 管理员与用户身份物理隔离：新建 admins 表，audit_logs.admin_id 改引 admins.id
--
-- 背景：原 users 表合表（role=0 用户 / role=1 管理员）。拆成 admins 表后：
--   - admins 只持后台操作身份（email + 密码 + 2FA），无任何用户业务数据
--   - 严格互斥：管理员与用户不共用账号
--   - 认证链路物理隔离（独立 cookie/密钥/登录端点，见 apps/*-api 改造）
--
-- 注意：reconcile_discrepancies 表由 0005 创建，numeric 类型变更也由 0005 完成。
--       本 migration 只处理 admins 表拆分（admin_id 外键从 users.id 改引 admins.id）。

CREATE TABLE IF NOT EXISTS "admins" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(64),
	"password_hash" varchar(255) NOT NULL,
	"two_factor_secret" varchar(64),
	"status" smallint DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admins_email_uq" ON "admins" USING btree ("email");
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_admin_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_admins_id_fk"
	FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
