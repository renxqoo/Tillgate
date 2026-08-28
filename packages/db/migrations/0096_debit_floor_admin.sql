-- 0096：透支地板管理面（方案 docs/debit-floor/DESIGN.md）。
-- 1) wallet_accounts.debit_floor_source：地板来源词表（default=随全局默认/批量，
--    manual=管理员手工覆盖——批量永不覆盖；group 为用户分组大需求预留位，本期不建）。
-- 2) 权限 funds:floor（透支地板管理）+ 三端点绑定：单用户设置 / 全局默认读写 / 存量批量。
alter table wallet_accounts
  add column if not exists debit_floor_source varchar(16) not null default 'default';

alter table wallet_accounts
  drop constraint if exists wallet_accounts_debit_floor_source_ck;
alter table wallet_accounts
  add constraint wallet_accounts_debit_floor_source_ck
  check (debit_floor_source in ('default', 'manual'));

--> statement-breakpoint
-- 权限树：挂「渠道资金」页按钮（与 funds:adjust 同族；管理台角色按需授权，超管天然短路）
INSERT INTO permissions (parent_id, type, code, name, sort_order, source)
SELECT p.id, 'button', 'funds:floor', '透支地板管理', 3, 'enforced'
FROM permissions p
WHERE p.i18n_key = 'nav.channelFunds' AND p.type = 'page'
  AND NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'funds:floor');

--> statement-breakpoint
INSERT INTO endpoint_permissions (method, path, permission_id, source)
SELECT v.method, v.path, v.permission_id, 'enforced'
FROM (VALUES
  ('PUT',  '/v1/users/:id/debit-floor',            (SELECT id FROM permissions WHERE code = 'funds:floor' LIMIT 1)),
  ('GET',  '/v1/settings/debit-floor-default',     (SELECT id FROM permissions WHERE code = 'funds:floor' LIMIT 1)),
  ('PUT',  '/v1/settings/debit-floor-default',     (SELECT id FROM permissions WHERE code = 'funds:floor' LIMIT 1)),
  ('POST', '/v1/wallets/debit-floor/apply-default',(SELECT id FROM permissions WHERE code = 'funds:floor' LIMIT 1))
) AS v(method, path, permission_id)
WHERE v.permission_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM endpoint_permissions e
    WHERE e.method = v.method AND e.path = v.path
  );
