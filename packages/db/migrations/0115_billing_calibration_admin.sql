-- 0115：收据校准管理面端点绑定（funds:floor 与预扣策略/透支地板同族——资金风险面）。
-- KV 本体在 system_configs['billing_calibration']（键单一真相在
-- billing/calibration-config.ts）；本迁移只登记 ACL 绑定，无表结构变更。
INSERT INTO endpoint_permissions (method, path, permission_id, source)
SELECT v.method, v.path, v.permission_id, 'enforced'
FROM (VALUES
  ('GET', '/v1/settings/billing-calibration', (SELECT id FROM permissions WHERE code = 'funds:floor' LIMIT 1)),
  ('PUT', '/v1/settings/billing-calibration', (SELECT id FROM permissions WHERE code = 'funds:floor' LIMIT 1))
) AS v(method, path, permission_id)
WHERE NOT EXISTS (
  SELECT 1 FROM endpoint_permissions ep
  WHERE ep.method = v.method AND ep.path = v.path
);
