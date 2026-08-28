-- 会话吊销真相迁移：users/admins.session_invalid_before 列 → identity-core 锚点表。
-- 依赖 identity_session_anchors 已由 identity-core provision 建出（migrate 容器/脚本先 provision 后 migrate）。
-- 幂等：on conflict 用 greatest 合并，重跑不放松已收紧的线。旧列保留只读。
INSERT INTO "identity_session_anchors" ("realm", "user_id", "invalid_before", "updated_at")
SELECT 'user', "id", "session_invalid_before", now()
FROM "users"
WHERE "session_invalid_before" IS NOT NULL
ON CONFLICT ("realm", "user_id")
DO UPDATE SET
  "invalid_before" = greatest("identity_session_anchors"."invalid_before", "excluded"."invalid_before"),
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "identity_session_anchors" ("realm", "user_id", "invalid_before", "updated_at")
SELECT 'admin', "id", "session_invalid_before", now()
FROM "admins"
WHERE "session_invalid_before" IS NOT NULL
ON CONFLICT ("realm", "user_id")
DO UPDATE SET
  "invalid_before" = greatest("identity_session_anchors"."invalid_before", "excluded"."invalid_before"),
  "updated_at" = now();
