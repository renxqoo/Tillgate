-- 0098：渠道用量证据缺陷计数（docs/usage-acceptance/DESIGN.md）。
-- 结算验收门钳制上游谎报发票时原子 +1；计数 ≥ 装配阈值（BILLING_USAGE_DEFECT_BREAKER）
-- → 熔断（status=3）。存量渠道缺省 0。
alter table channels
  add column if not exists usage_evidence_defects bigint not null default 0;
