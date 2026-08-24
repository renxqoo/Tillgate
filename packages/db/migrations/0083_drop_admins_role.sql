-- 0083：RBAC v2 切换收尾——drop admins.role varchar 旧列与词表 CHECK。
-- 前置：0082 已建 permissions/roles/role_permissions 并回填 admins.role_id（NOT NULL）;
-- 消费方（control-plane admin-store / admin-api 路由与脚本）已全部切换 roleId。
-- 零兼容层：旧列即删,不留双轨。

--> statement-breakpoint
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_ck;

--> statement-breakpoint
ALTER TABLE admins DROP COLUMN IF EXISTS role;
