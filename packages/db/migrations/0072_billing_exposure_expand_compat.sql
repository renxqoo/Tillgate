-- Expand/contract 发布兼容：迁移先于应用滚动时，旧副本仍不会写新列。
-- NULL 行风险汇总回退 reserved_amount；全部副本升级并完成回填后再单独收紧 NOT NULL。
alter table billing_requests
  alter column estimated_exposure_amount drop not null;
