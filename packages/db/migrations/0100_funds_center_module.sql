-- 0100：资金中心模块（docs/funds-center/DESIGN.md）。
-- 1) 页节点 nav.channelFunds 原地升格 nav.funds（/dashboard/funds）——按钮 funds:adjust/
--    recharge/floor 随页迁移（parent 不变）；
-- 2) 新按钮权限 funds:fx（汇率管理——override/buffer/refresh 高杠杆资金操作，独立可授权）；
-- 3) fx 四端点重绑：状态读归 funds:read（页签可见），管理动作归 funds:fx
--    （原 catalog:* 绑定解除——目录域权限不再覆盖资金面）。
update permissions
   set i18n_key = 'nav.funds',
       path = '/dashboard/funds',
       name = '资金管理',
       updated_at = now()
 where i18n_key = 'nav.channelFunds' and type = 'page';

--> statement-breakpoint
INSERT INTO permissions (parent_id, type, code, name, sort_order, source)
SELECT p.id, 'button', 'funds:fx', '汇率管理', 4, 'enforced'
FROM permissions p
WHERE p.i18n_key = 'nav.funds' AND p.type = 'page'
  AND NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'funds:fx');

--> statement-breakpoint
DELETE FROM endpoint_permissions
 WHERE path IN ('/v1/fx/catalog', '/v1/fx/catalog/override', '/v1/fx/catalog/buffer', '/v1/fx/catalog/refresh');

--> statement-breakpoint
INSERT INTO endpoint_permissions (method, path, permission_id, source)
SELECT v.method, v.path, v.permission_id, 'enforced'
FROM (VALUES
  ('GET',    '/v1/fx/catalog',           (SELECT id FROM permissions WHERE code = 'funds:read' LIMIT 1)),
  ('PUT',    '/v1/fx/catalog/override',  (SELECT id FROM permissions WHERE code = 'funds:fx' LIMIT 1)),
  ('DELETE', '/v1/fx/catalog/override',  (SELECT id FROM permissions WHERE code = 'funds:fx' LIMIT 1)),
  ('PUT',    '/v1/fx/catalog/buffer',    (SELECT id FROM permissions WHERE code = 'funds:fx' LIMIT 1)),
  ('POST',   '/v1/fx/catalog/refresh',   (SELECT id FROM permissions WHERE code = 'funds:fx' LIMIT 1))
) AS v(method, path, permission_id)
WHERE NOT EXISTS (
  SELECT 1 FROM endpoint_permissions ep
  WHERE ep.method = v.method AND ep.path = v.path
);

--> statement-breakpoint
-- 平台币种 KV 种子（写一次配置的初值;各 app 启动读取,单一真相替代 env/常量散布）
INSERT INTO system_configs (key, value, updated_by_admin_id)
VALUES ('platform_currency', '{"currency": "CNY"}'::jsonb, NULL)
ON CONFLICT (key) DO NOTHING;

--> statement-breakpoint
INSERT INTO endpoint_permissions (method, path, permission_id, source)
SELECT v.method, v.path, v.permission_id, 'enforced'
FROM (VALUES
  ('GET', '/v1/settings/platform-currency', (SELECT id FROM permissions WHERE code = 'funds:floor' LIMIT 1)),
  ('PUT', '/v1/settings/platform-currency', (SELECT id FROM permissions WHERE code = 'funds:floor' LIMIT 1))
) AS v(method, path, permission_id)
WHERE NOT EXISTS (
  SELECT 1 FROM endpoint_permissions ep
  WHERE ep.method = v.method AND ep.path = v.path
);
