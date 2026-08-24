-- 0081：管理端 RBAC——admins.role 角色列（封闭词表）。
-- DEFAULT 'super_admin' 是对既有行的回填（旧形态唯一管理员全权限 = 唯一规格，零破坏）：
-- 单管理员部署迁移后保持全部权限；新建管理员必经 POST /v1/admins 契约显式传 role。
-- 词表与 control-plane domain/rbac ADMIN_ROLES 一致（权限矩阵单一真相在代码，DB 只兜底）。
-- 幂等：ADD COLUMN IF NOT EXISTS + DO 块守卫约束（check 无 IF NOT EXISTS 语法）。

--> statement-breakpoint
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role varchar(32) NOT NULL DEFAULT 'super_admin';

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admins_role_ck'
  ) THEN
    ALTER TABLE admins ADD CONSTRAINT admins_role_ck
      CHECK (role IN ('super_admin', 'operator', 'finance', 'support', 'viewer'));
  END IF;
END
$$;
