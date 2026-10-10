-- identity 系列补 user_id 外键（与 apps/api_keys 等既有 user_id 外键口径对齐）。
--
-- 事故背景：identity_credentials 允许写入指向不存在 users 行的 user_id，孤儿凭据
-- 行不会被任何清理路径回收。register 的 emailTaken() 预检以凭据表为权威，于是
-- 孤儿行让该邮箱永久命中「已占用」分支；叠加 0736ba8 的防枚举哑口径（已占邮箱
-- 同款 code_required 但不建挑战不发码），用户表现为「注册跳到验证码步却永远收不到
-- 邮件」——服务端无任何报错，纯粹静默失效。
--
-- 本迁移两段：先清孤儿（子表优先，无 FK 保护故按引用关系手工排序），再建约束。
-- 存量孤儿全部指向 1000000000/1000000001 两个未在任何 users 行出现的虚构 id
-- （该数值在代码中无来源），无真实用户数据牵连。
--
-- ON DELETE CASCADE：与 users 既有子表（apps/api_keys）同口径，用户注销即级联，
-- 不留新孤儿。
--
-- 清理顺序（自引用方先删，避免留下新的孤儿）：
--   recovery_codes/totp/passwords/credentials → session_anchors → oauth_links → challenges
-- challenges.user_id 可空且存量无孤儿，但补约束后该列同样受保护。

DELETE FROM identity_recovery_codes r
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id);
DELETE FROM identity_totp t
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.user_id);
DELETE FROM identity_passwords p
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id);
DELETE FROM identity_credentials c
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id);
DELETE FROM identity_session_anchors a
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id);
DELETE FROM identity_oauth_links o
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = o.user_id);
DELETE FROM identity_challenges c
  WHERE c.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id);

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
