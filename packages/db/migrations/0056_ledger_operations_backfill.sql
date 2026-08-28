-- 幂等操作档案迁移：fund_operations → ledger-core 的 ledger_operations。
-- 依赖 ledger_operations 已由 ledger-core provision 建出（migrate 链先 provision 后 migrate）。
-- 幂等：on conflict do nothing（operation_id 全局唯一；重跑不产生重复行）。
-- 注意：历史行保留旧指纹算法（JSON.stringify），
-- 切换后重放旧 operationId 会以 idempotency_conflict 暴露而非误重放——安全方向。
-- 旧表保留只读观察。
INSERT INTO "ledger_operations" ("operation_id", "kind", "fingerprint", "receipt", "created_at", "updated_at")
SELECT "operation_id", "kind", "fingerprint", "result", "created_at", now()
FROM "fund_operations"
ON CONFLICT ("operation_id") DO NOTHING;
