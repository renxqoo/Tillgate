-- 0084：接口权限绑定（ADR-0009:执行面数据化——全局 ACL 中间件消费本表）。
-- 单一事实源:绑定按 permission_id 外键（改码零漂移）;未绑定路由默认拒绝
-- （fail-closed;公开/自身白名单在代码侧——结构性端点不属运营配置）。
-- 种子 = 原 guard(code) 逐端点声明的机械导出（104 条）+ 绑定管理端点自身（4 条）。

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS endpoint_permissions (
  id bigserial PRIMARY KEY,
  method varchar(10) NOT NULL,
  path varchar(255) NOT NULL,
  permission_id bigint NOT NULL REFERENCES permissions(id),
  source varchar(16) NOT NULL DEFAULT 'custom',
  created_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS endpoint_permissions_endpoint_uq
  ON endpoint_permissions (method, path);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS endpoint_permissions_permission_idx
  ON endpoint_permissions (permission_id);

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'endpoint_permissions_method_ck') THEN
    ALTER TABLE endpoint_permissions ADD CONSTRAINT endpoint_permissions_method_ck
      CHECK (method IN ('GET','HEAD','POST','PUT','PATCH','DELETE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'endpoint_permissions_source_ck') THEN
    ALTER TABLE endpoint_permissions ADD CONSTRAINT endpoint_permissions_source_ck
      CHECK (source IN ('enforced','custom'));
  END IF;
END
$$;

--> statement-breakpoint
INSERT INTO endpoint_permissions (method, path, permission_id, source)
SELECT v.method, v.path, v.permission_id, 'enforced'
FROM (VALUES
  ('GET', '/v1/admin-keys', (SELECT id FROM permissions WHERE code = 'users:read' LIMIT 1)),
  ('PATCH', '/v1/admin-keys/:id', (SELECT id FROM permissions WHERE code = 'users:update' LIMIT 1)),
  ('GET', '/v1/admins', (SELECT id FROM permissions WHERE code = 'admins:read' LIMIT 1)),
  ('POST', '/v1/admins', (SELECT id FROM permissions WHERE code = 'admins:create' LIMIT 1)),
  ('PATCH', '/v1/admins/:id', (SELECT id FROM permissions WHERE code = 'admins:update' LIMIT 1)),
  ('GET', '/v1/analytics/channel-ttft', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/audit-logs', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/billing-operations', (SELECT id FROM permissions WHERE code = 'funds:read' LIMIT 1)),
  ('POST', '/v1/billing-operations/:requestId/abandon', (SELECT id FROM permissions WHERE code = 'funds:abandon' LIMIT 1)),
  ('POST', '/v1/billing-operations/:requestId/retry', (SELECT id FROM permissions WHERE code = 'funds:retry' LIMIT 1)),
  ('GET', '/v1/channel-funds', (SELECT id FROM permissions WHERE code = 'funds:read' LIMIT 1)),
  ('POST', '/v1/channel-funds/adjust', (SELECT id FROM permissions WHERE code = 'funds:adjust' LIMIT 1)),
  ('POST', '/v1/channel-funds/recharge', (SELECT id FROM permissions WHERE code = 'funds:recharge' LIMIT 1)),
  ('GET', '/v1/channels', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1)),
  ('POST', '/v1/channels', (SELECT id FROM permissions WHERE code = 'catalog:create' LIMIT 1)),
  ('DELETE', '/v1/channels/:id', (SELECT id FROM permissions WHERE code = 'catalog:delete' LIMIT 1)),
  ('PATCH', '/v1/channels/:id', (SELECT id FROM permissions WHERE code = 'catalog:update' LIMIT 1)),
  ('POST', '/v1/channels/:id/restore', (SELECT id FROM permissions WHERE code = 'catalog:restore' LIMIT 1)),
  ('POST', '/v1/channels/:id/test', (SELECT id FROM permissions WHERE code = 'catalog:test' LIMIT 1)),
  ('POST', '/v1/channels/import', (SELECT id FROM permissions WHERE code = 'catalog:import' LIMIT 1)),
  ('GET', '/v1/endpoint-bindings', (SELECT id FROM permissions WHERE code = 'admins:read' LIMIT 1)),
  ('POST', '/v1/endpoint-bindings', (SELECT id FROM permissions WHERE code = 'admins:create' LIMIT 1)),
  ('DELETE', '/v1/endpoint-bindings/:id', (SELECT id FROM permissions WHERE code = 'admins:delete' LIMIT 1)),
  ('PATCH', '/v1/endpoint-bindings/:id', (SELECT id FROM permissions WHERE code = 'admins:update' LIMIT 1)),
  ('GET', '/v1/fx/catalog', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1)),
  ('PUT', '/v1/fx/catalog/buffer', (SELECT id FROM permissions WHERE code = 'catalog:update' LIMIT 1)),
  ('DELETE', '/v1/fx/catalog/override', (SELECT id FROM permissions WHERE code = 'catalog:update' LIMIT 1)),
  ('PUT', '/v1/fx/catalog/override', (SELECT id FROM permissions WHERE code = 'catalog:update' LIMIT 1)),
  ('POST', '/v1/fx/catalog/refresh', (SELECT id FROM permissions WHERE code = 'catalog:refresh' LIMIT 1)),
  ('GET', '/v1/generation-tasks', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/logs', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/marketing/settings', (SELECT id FROM permissions WHERE code = 'growth:read' LIMIT 1)),
  ('PUT', '/v1/marketing/settings', (SELECT id FROM permissions WHERE code = 'growth:update' LIMIT 1)),
  ('GET', '/v1/model-catalog/:sourceId', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1)),
  ('POST', '/v1/model-catalog/import', (SELECT id FROM permissions WHERE code = 'catalog:import' LIMIT 1)),
  ('GET', '/v1/model-catalog/price-history', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1)),
  ('GET', '/v1/model-catalog/sources', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1)),
  ('GET', '/v1/models', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1)),
  ('POST', '/v1/models', (SELECT id FROM permissions WHERE code = 'catalog:create' LIMIT 1)),
  ('DELETE', '/v1/models/:id', (SELECT id FROM permissions WHERE code = 'catalog:delete' LIMIT 1)),
  ('PATCH', '/v1/models/:id', (SELECT id FROM permissions WHERE code = 'catalog:update' LIMIT 1)),
  ('POST', '/v1/models/:id/channels', (SELECT id FROM permissions WHERE code = 'catalog:bind' LIMIT 1)),
  ('POST', '/v1/models/:id/restore', (SELECT id FROM permissions WHERE code = 'catalog:restore' LIMIT 1)),
  ('POST', '/v1/models/:id/test', (SELECT id FROM permissions WHERE code = 'catalog:test' LIMIT 1)),
  ('GET', '/v1/notifications', (SELECT id FROM permissions WHERE code = 'growth:read' LIMIT 1)),
  ('POST', '/v1/notifications', (SELECT id FROM permissions WHERE code = 'growth:create' LIMIT 1)),
  ('DELETE', '/v1/notifications/:id', (SELECT id FROM permissions WHERE code = 'growth:delete' LIMIT 1)),
  ('PATCH', '/v1/notifications/:id', (SELECT id FROM permissions WHERE code = 'growth:update' LIMIT 1)),
  ('POST', '/v1/notifications/:id/test', (SELECT id FROM permissions WHERE code = 'growth:test' LIMIT 1)),
  ('GET', '/v1/payment-orders', (SELECT id FROM permissions WHERE code = 'funds:read' LIMIT 1)),
  ('POST', '/v1/payment-orders/:id/close', (SELECT id FROM permissions WHERE code = 'funds:close' LIMIT 1)),
  ('POST', '/v1/permissions', (SELECT id FROM permissions WHERE code = 'admins:create' LIMIT 1)),
  ('DELETE', '/v1/permissions/:id', (SELECT id FROM permissions WHERE code = 'admins:delete' LIMIT 1)),
  ('PATCH', '/v1/permissions/:id', (SELECT id FROM permissions WHERE code = 'admins:update' LIMIT 1)),
  ('GET', '/v1/permissions/tree', (SELECT id FROM permissions WHERE code = 'admins:read' LIMIT 1)),
  ('GET', '/v1/plans', (SELECT id FROM permissions WHERE code = 'plans:read' LIMIT 1)),
  ('POST', '/v1/plans', (SELECT id FROM permissions WHERE code = 'plans:create' LIMIT 1)),
  ('DELETE', '/v1/plans/:id', (SELECT id FROM permissions WHERE code = 'plans:delete' LIMIT 1)),
  ('PATCH', '/v1/plans/:id', (SELECT id FROM permissions WHERE code = 'plans:update' LIMIT 1)),
  ('GET', '/v1/providers', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1)),
  ('POST', '/v1/providers', (SELECT id FROM permissions WHERE code = 'catalog:create' LIMIT 1)),
  ('DELETE', '/v1/providers/:id', (SELECT id FROM permissions WHERE code = 'catalog:delete' LIMIT 1)),
  ('PATCH', '/v1/providers/:id', (SELECT id FROM permissions WHERE code = 'catalog:update' LIMIT 1)),
  ('POST', '/v1/providers/:id/restore', (SELECT id FROM permissions WHERE code = 'catalog:restore' LIMIT 1)),
  ('GET', '/v1/rate-cards', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1)),
  ('POST', '/v1/rate-cards', (SELECT id FROM permissions WHERE code = 'catalog:create' LIMIT 1)),
  ('DELETE', '/v1/rate-cards/:id', (SELECT id FROM permissions WHERE code = 'catalog:delete' LIMIT 1)),
  ('PATCH', '/v1/rate-cards/:id', (SELECT id FROM permissions WHERE code = 'catalog:update' LIMIT 1)),
  ('GET', '/v1/rate-cards/:id/health', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1)),
  ('GET', '/v1/rate-cards/:id/users', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1)),
  ('GET', '/v1/redeem-batches', (SELECT id FROM permissions WHERE code = 'funds:read' LIMIT 1)),
  ('POST', '/v1/redeem-batches', (SELECT id FROM permissions WHERE code = 'funds:create' LIMIT 1)),
  ('GET', '/v1/redeem-batches/:id', (SELECT id FROM permissions WHERE code = 'funds:read' LIMIT 1)),
  ('GET', '/v1/redeem-batches/:id/codes', (SELECT id FROM permissions WHERE code = 'funds:read' LIMIT 1)),
  ('POST', '/v1/redeem-batches/codes/:codeId/revoke', (SELECT id FROM permissions WHERE code = 'funds:revoke' LIMIT 1)),
  ('GET', '/v1/referrals/payouts', (SELECT id FROM permissions WHERE code = 'growth:read' LIMIT 1)),
  ('GET', '/v1/referrals/relations', (SELECT id FROM permissions WHERE code = 'growth:read' LIMIT 1)),
  ('PATCH', '/v1/referrals/relations/:id', (SELECT id FROM permissions WHERE code = 'growth:update' LIMIT 1)),
  ('GET', '/v1/roles', (SELECT id FROM permissions WHERE code = 'admins:read' LIMIT 1)),
  ('POST', '/v1/roles', (SELECT id FROM permissions WHERE code = 'admins:create' LIMIT 1)),
  ('DELETE', '/v1/roles/:id', (SELECT id FROM permissions WHERE code = 'admins:delete' LIMIT 1)),
  ('PATCH', '/v1/roles/:id', (SELECT id FROM permissions WHERE code = 'admins:update' LIMIT 1)),
  ('GET', '/v1/settings/billing-timezone', (SELECT id FROM permissions WHERE code = 'settings:read' LIMIT 1)),
  ('PUT', '/v1/settings/billing-timezone', (SELECT id FROM permissions WHERE code = 'settings:update' LIMIT 1)),
  ('GET', '/v1/stats/overview', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/stats/trends', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/stats/usage', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/subscriptions', (SELECT id FROM permissions WHERE code = 'plans:read' LIMIT 1)),
  ('POST', '/v1/subscriptions/:id/cancel', (SELECT id FROM permissions WHERE code = 'plans:cancel' LIMIT 1)),
  ('POST', '/v1/subscriptions/:id/change', (SELECT id FROM permissions WHERE code = 'plans:change' LIMIT 1)),
  ('POST', '/v1/subscriptions/:id/grant', (SELECT id FROM permissions WHERE code = 'plans:grant' LIMIT 1)),
  ('POST', '/v1/subscriptions/:id/renew', (SELECT id FROM permissions WHERE code = 'plans:renew' LIMIT 1)),
  ('GET', '/v1/tracing/by-request/:requestId', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/tracing/recent', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/tracing/stats', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/tracing/topology', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/tracing/traces/:traceId', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/usage-logs', (SELECT id FROM permissions WHERE code = 'ops:read' LIMIT 1)),
  ('GET', '/v1/users', (SELECT id FROM permissions WHERE code = 'users:read' LIMIT 1)),
  ('GET', '/v1/users/:id', (SELECT id FROM permissions WHERE code = 'users:read' LIMIT 1)),
  ('PATCH', '/v1/users/:id', (SELECT id FROM permissions WHERE code = 'users:update' LIMIT 1)),
  ('POST', '/v1/users/:id/adjust', (SELECT id FROM permissions WHERE code = 'funds:adjust' LIMIT 1)),
  ('GET', '/v1/users/:id/audit-logs', (SELECT id FROM permissions WHERE code = 'users:read' LIMIT 1)),
  ('POST', '/v1/users/:id/gift', (SELECT id FROM permissions WHERE code = 'funds:gift' LIMIT 1)),
  ('POST', '/v1/users/:id/set-password', (SELECT id FROM permissions WHERE code = 'users:set-password' LIMIT 1)),
  ('GET', '/v1/users/:id/transactions', (SELECT id FROM permissions WHERE code = 'funds:read' LIMIT 1)),
  ('GET', '/v1/vendor-catalog', (SELECT id FROM permissions WHERE code = 'catalog:read' LIMIT 1)),
  ('GET', '/v1/vouchers/:key', (SELECT id FROM permissions WHERE code = 'funds:read' LIMIT 1))
) AS v(method, path, permission_id)
WHERE v.permission_id IS NOT NULL
ON CONFLICT (method, path) DO NOTHING;
