-- 0087：集成设置写权限拆分（安全加固）。
-- 动机：SMTP host / captcha verifyUrl / oauth.base 等「出网点」字段动态化后，持有
-- settings:update 的角色即可外带 secret（改收件地址）或拦截密码重置邮件——把集成
-- 凭据写入收窄到独立权限码 settings:integrations（超管不受影响；运营角色需显式授予）。
-- 绑定迁移：PUT /v1/settings/integrations/:key 从 settings:update 改挂新码
-- （GET 仍为 settings:read——掩码只读面维持原授权）。

--> statement-breakpoint
INSERT INTO permissions (parent_id, type, code, name, sort_order, source)
SELECT p.id, 'button', 'settings:integrations', '第三方集成配置（凭据/出网点写入）', 2, 'enforced'
FROM permissions p
WHERE p.i18n_key = 'nav.settings' AND p.type = 'page'
ON CONFLICT DO NOTHING;  -- permissions_code_uq（button 部分唯一索引）覆盖 code

--> statement-breakpoint
UPDATE endpoint_permissions ep
SET permission_id = (SELECT id FROM permissions WHERE code = 'settings:integrations' LIMIT 1)
WHERE ep.method = 'PUT' AND ep.path = '/v1/settings/integrations/:key';
