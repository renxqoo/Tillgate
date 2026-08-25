-- 0089：凭据旧列退役（identity MIGRATION §8 W1 收尾）——drop users/admins.password_hash。
-- 前置：凭据单一真相在 identity 七表（identity_credentials ⋈ identity_passwords），
-- 注册/登录/改密/重置全链路只读写 identity 表；v2 起的库（seed/create-admin/HTTP 建号）
-- 旧列数据为同值双写或 'identity-managed' 占位，删除零信息损失。
-- 范围裁决（2026-08-26 维护者）：v2 环境为唯一目标——v1 存量库的 users 半边存量
-- 迁移不再作为保留条件，旧列即删。
-- 零兼容层：不留双轨、无回读（铁律 8）。session_invalid_before 不在本迁移
-- （0055 注释的 P5 统一 DROP 口径另案收口）。

--> statement-breakpoint
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;

--> statement-breakpoint
ALTER TABLE admins DROP COLUMN IF EXISTS password_hash;
