-- 0091：管理员 TOTP 密钥旧列退役——drop admins.two_factor_secret。
-- 前置：TOTP 单一真相在 identity_totp（enroll/confirm/verify-totp-only 全链路读写），
-- 本列为「预留」从未接线，全表恒 NULL，零代码消费者——删除零信息损失。
-- 2FA 偏好开关 two_factor_enabled 是现役列（登录两步编排消费），不在本迁移。
-- 与 0089/0090 同口径：零兼容层、不留双轨。

--> statement-breakpoint
ALTER TABLE admins DROP COLUMN IF EXISTS two_factor_secret;
