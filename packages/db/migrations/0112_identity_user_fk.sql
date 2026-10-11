-- ⚠️ 本迁移的事故与撤销：见 0113 头注——identity_user_id 是 user/admin 双 realm 共用的
-- 扁平主键，管理员 id（≥1e9 段，ADMIN_ID_SEGMENT_FLOOR）按设计不在 users 表。本迁移
-- 的孤儿清理在已应用的库上误删了全部存量管理员凭据/密码/TOTP 行（不可恢复），FK 则
-- 拦截一切管理员身份写入（23503）。0113 已撤销 FK；本文件下方 DELETE 段已被改写为
-- no-op——drizzle migrator 按 journal 时间戳判重放、不校验文件哈希，已应用库不受
-- 本改写影响；lagging 库（journal 未到本条）追平将执行改写后的 no-op 版本，不再
-- 重演数据删除。原始 DELETE 语句的语义记录见本注释与 0113。
--
-- 原始动机（保留历史，其判断错误之处已订正）：identity_credentials 允许写入指向
-- 不存在 users 行的 user_id，孤儿凭据行不会被任何清理路径回收。register 的
-- emailTaken() 预检以凭据表为权威，孤儿行让该邮箱永久命中「已占用」分支；叠加
-- 0736ba8 的防枚举哑口径（已占邮箱同款 code_required 但不建挑战不发码），用户表现
-- 为「注册跳到验证码步却永远收不到邮件」。原断言「存量孤儿指向 1000000000/
-- 1000000001 两个无来源虚构 id、无真实用户数据牵连」是错的——1e9 正是 admin id
-- 段分配下限（admin-store ADMIN_ID_SEGMENT_FLOOR），被删的就是真实管理员凭据。
--
-- 本迁移现在只保留 ADD CONSTRAINT 段（对 lagging 库照常执行，随后的 0113 会将其
-- 撤销——两步对零身份数据的库是等价 no-op；已应用 0112 的库本段已生效、由 0113 撤）。
--
-- 清理顺序（原 DELETE 段的引用顺序，仅存档）：
--   recovery_codes/totp/passwords/credentials → session_anchors → oauth_links → challenges

-- （原孤儿清理 DELETE 段已被 0113 后续改写为 no-op——理由见文件头；do-nothing 语句
--  保持文件可追溯，不执行任何删除）

ALTER TABLE identity_recovery_codes
  ADD CONSTRAINT identity_recovery_codes_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE identity_totp
  ADD CONSTRAINT identity_totp_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE identity_passwords
  ADD CONSTRAINT identity_passwords_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE identity_credentials
  ADD CONSTRAINT identity_credentials_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE identity_session_anchors
  ADD CONSTRAINT identity_session_anchors_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE identity_oauth_links
  ADD CONSTRAINT identity_oauth_links_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE identity_challenges
  ADD CONSTRAINT identity_challenges_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
