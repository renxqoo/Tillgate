-- 0113：撤销 0112 加在 identity 七表的 user_id → users.id 外键。
--
-- 事故：identity_user_id 是 user/admin 双 realm 共用的扁平主键（identity 包不解释
-- 用户语义；管理员凭据按 admin-store 段分配落 ≥1e9 段，admins 与 users 严格互斥
-- —— admins 表头注）。0112 把该列按「子表指向 users 的引用」处理：
--   1) 孤儿清理把存量管理员凭据/密码/TOTP 行当孤儿删除——生产（2026-10-11）全部
--      管理员随即 Invalid credentials 登录失效，密码哈希不可恢复；
--   2) FK 建立后一切管理员身份写入（TOTP 绑定/确认、邀请设密、2FA 发码、锚点推进）
--      23503——绑定验证器报「引用的资源不存在」。
-- 0112 注释断言「1000000000/1000000001 是无来源虚构 id」——1e9 正是 admin id
-- 段分配下限（ADMIN_ID_SEGMENT_FLOOR），断言错误是本事故的根因。
--
-- 裁决：撤 FK 恢复 0076 起的双 realm 扁平主键口径。user realm 的孤儿凭据问题
-- （0112 想解决的）不在 FK 层解决——引用完整性由消费方（accounts/admin-api 编排
-- 层）保证，与 identity 包「不解释用户语义」的边界一致。
--
-- 已应用 0112 的库跑本迁移即恢复；未应用 0112 的 lagging 库（staging/灾备/未追平
-- 开发库）追平链时：0112 已被整体改写为 no-op（migrator 按 journal 时间戳判重放
-- 不校验哈希——改写仅对 lagging 库生效），本迁移对其等价零操作，一步到达零 FK
-- 终态，管理员身份数据不经历任何删除或约束校验窗口。生产数据恢复（重发管理员
-- 密码/重绑 TOTP）是运维动作，不在迁移内。

ALTER TABLE identity_recovery_codes
  DROP CONSTRAINT IF EXISTS identity_recovery_codes_user_id_users_id_fk;
ALTER TABLE identity_totp
  DROP CONSTRAINT IF EXISTS identity_totp_user_id_users_id_fk;
ALTER TABLE identity_passwords
  DROP CONSTRAINT IF EXISTS identity_passwords_user_id_users_id_fk;
ALTER TABLE identity_credentials
  DROP CONSTRAINT IF EXISTS identity_credentials_user_id_users_id_fk;
ALTER TABLE identity_session_anchors
  DROP CONSTRAINT IF EXISTS identity_session_anchors_user_id_users_id_fk;
ALTER TABLE identity_oauth_links
  DROP CONSTRAINT IF EXISTS identity_oauth_links_user_id_users_id_fk;
ALTER TABLE identity_challenges
  DROP CONSTRAINT IF EXISTS identity_challenges_user_id_users_id_fk;
