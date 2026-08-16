-- 管理员邮箱验证码二次登录（第八轮）：默认关闭的自助开关。
-- 开启后登录两步：密码正确 → 邮箱收 6 位码（5 分钟有效）→ 验证通过才签发会话。
-- SMTP 未配置时 fail-closed（开启失败/登录返回 503），绝不静默降级为单密码。
ALTER TABLE "admins" ADD COLUMN "two_factor_enabled" boolean NOT NULL DEFAULT false;
