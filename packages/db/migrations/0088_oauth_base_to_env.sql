-- 0088：OAuth 基地址退回 env（ADR-0012，取代 DESIGN D9 初版入库裁决）。
-- 动机：oauth.base 装配期读取、变更需重启——DB 集成设置的卖点（即时生效/审计/
-- step-up）对其一条不成立，且 frontendUrl/apiBase 是部署拓扑（部署层已有真相：
-- 前端构建地址、CORS_ORIGINS），管理台手填制造第二真相与「改了不生效」陷阱。
-- 动作：CHECK 词表收窄（6 键）+ 清存量行（内部阶段无兼容窗；存量部署把卡片
-- 值抄进 OAUTH_FRONTEND_URL / OAUTH_API_BASE env 即完成迁移——ADR-0012）。

ALTER TABLE "integration_settings" DROP CONSTRAINT "integration_settings_key_ck";
--> statement-breakpoint
ALTER TABLE "integration_settings"
  ADD CONSTRAINT "integration_settings_key_ck"
  CHECK ("key" IN ('oauth.github','oauth.google','smtp','captcha.turnstile','payment.epay','payment.stripe'));
--> statement-breakpoint
DELETE FROM "integration_settings" WHERE "key" = 'oauth.base';
