-- 0093：管理员邀请重发端点绑定。
-- 动机：新建管理员改为邀请制（邮件一次性链接设置初始密码,docs/admin-invite/
-- DESIGN.md），列表新增「重发邀请」操作（POST /v1/admins/:id/resend-invite）。
-- ACL 数据驱动 fail-closed——不绑权限即 403。绑定到既有 admins:update 码
-- （0092 先例：重发是对既有管理员行的操作,持 admins:update 者本就可改其
-- role/status,重发邀请未扩大授权面;不新增权限码——ENFORCED_CODES 不变）。
-- 回滚：DELETE FROM endpoint_permissions WHERE method = 'POST'
--   AND path = '/v1/admins/:id/resend-invite';

--> statement-breakpoint
INSERT INTO endpoint_permissions (method, path, permission_id, source)
SELECT 'POST', '/v1/admins/:id/resend-invite',
  (SELECT id FROM permissions WHERE code = 'admins:update' LIMIT 1), 'enforced'
ON CONFLICT (method, path) DO NOTHING;
