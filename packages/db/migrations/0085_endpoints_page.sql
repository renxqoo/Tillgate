-- 接口绑定独立成页（原与权限树同页）:
--   系统管理组新增「接口绑定」页面节点,与「权限资源」共享 admins:read 域读码——
--   导航(/v1/me/menus)与 ACL 均按码判定,既有角色的 admins:read 授权自动覆盖新页,
--   无需补授权行;安全设置排序后移一位。
INSERT INTO permissions (parent_id, type, code, name, i18n_key, path, icon, sort_order, source)
SELECT g.id, 'page', 'admins:read', '接口绑定', 'nav.endpoints', '/dashboard/endpoints', 'Plug', 4, 'enforced'
FROM permissions g
WHERE g.i18n_key = 'nav.groupSystem' AND g.type = 'group';

--> statement-breakpoint
UPDATE permissions SET sort_order = 5
WHERE i18n_key = 'nav.settings' AND type = 'page' AND sort_order = 4;
