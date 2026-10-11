-- 0114 回滚：校准管理面 ACL 绑定清理（KV 行由 0113 down 一并处理）。
DELETE FROM endpoint_permissions
WHERE method IN ('GET', 'PUT') AND path = '/v1/settings/billing-calibration';
