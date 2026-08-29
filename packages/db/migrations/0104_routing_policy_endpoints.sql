-- 智能路由管理端点权限绑定 + 导航页节点（catalog 域——与渠道/模型管理同域读写语义）：
--   GET  /v1/routing-policy              + GET /v1/routing/channels-overview → catalog:read
--   PUT  /v1/routing-policy（改全局路由策略，高影响写）          → catalog:update
-- 页节点挂「模型管理」组（路由策略与渠道/模型同域），绑定按码共享——既有角色
-- 的 catalog:read 授权自动覆盖新页与端点，无需补授权行。
-- 回滚：
--   DELETE FROM endpoint_permissions WHERE method IN ('GET','PUT')
--     AND path IN ('/v1/routing-policy','/v1/routing/channels-overview');
--   DELETE FROM permissions WHERE i18n_key = 'nav.routing' AND type = 'page';

--> statement-breakpoint
INSERT INTO endpoint_permissions (method, path, permission_id, source) VALUES
  ('GET', '/v1/routing-policy', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1), 'enforced'),
  ('PUT', '/v1/routing-policy', (SELECT id FROM permissions WHERE code = 'catalog:update' LIMIT 1), 'enforced'),
  ('GET', '/v1/routing/channels-overview', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1), 'enforced')
ON CONFLICT (method, path) DO NOTHING;

--> statement-breakpoint
INSERT INTO permissions (parent_id, type, code, name, i18n_key, path, icon, sort_order, source)
SELECT g.id, 'page', 'catalog:read', '智能路由', 'nav.routing', '/dashboard/routing', 'Network', 5, 'enforced'
FROM permissions g
WHERE g.i18n_key = 'nav.groupModels' AND g.type = 'group';
