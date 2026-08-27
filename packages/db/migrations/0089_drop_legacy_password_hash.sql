-- 0089：凭据旧列退役——drop users/admins.password_hash。
-- 前置：凭据单一真相在 identity 七表（identity_credentials ⋈ identity_passwords），
-- 注册/登录/改密/重置全链路只读写 identity 表；经 seed/create-admin/HTTP 建号
-- 写入的旧列数据为同值双写或 'identity-managed' 占位，删除零信息损失。
-- 零兼容层：不留双轨、无回读。session_invalid_before 旧列由 0090 另行退役。

--> statement-breakpoint
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;

--> statement-breakpoint
ALTER TABLE admins DROP COLUMN IF EXISTS password_hash;
