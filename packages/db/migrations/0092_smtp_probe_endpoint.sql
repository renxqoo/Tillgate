-- 0092：SMTP 集成连通性探针端点绑定。
-- 动机：集成设置弹窗新增「测试连接」（POST /v1/settings/integrations/smtp/test，
-- 连接+认证校验不发送邮件）。ACL 数据驱动 fail-closed——不绑权限即 403，
-- 故绑定到既有 settings:integrations 码（0087 拆分）：持码者本就可写这些
-- 出网点/凭据，探针只读不落库，未扩大授权面；不新增权限码。
-- 回滚：DELETE FROM endpoint_permissions WHERE method = 'POST'
--   AND path = '/v1/settings/integrations/smtp/test';

--> statement-breakpoint
INSERT INTO endpoint_permissions (method, path, permission_id, source)
SELECT 'POST', '/v1/settings/integrations/smtp/test',
  (SELECT id FROM permissions WHERE code = 'settings:integrations' LIMIT 1), 'enforced'
ON CONFLICT (method, path) DO NOTHING;
