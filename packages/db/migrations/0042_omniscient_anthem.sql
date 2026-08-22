-- C 端邮箱登录（本轮）：本地账号 email 唯一索引（部分索引）。
-- 登录标识从 subject 切换到 email；NULL 排除——OIDC 用户/无邮箱账号不受约束。
-- 存量审计：495 个本地账号邮箱 0 重复、全小写，直接建索引无数据治理需求。
-- （admins.two_factor_enabled 与 request_logs.candidates_tried 为 journal 漂移回声，
--   已分别由 0041 / 0039 覆盖，此处不重复执行。）
CREATE UNIQUE INDEX "users_local_email_uq" ON "users" USING btree ("email") WHERE "users"."issuer" = 'local' and "users"."email" is not null;
