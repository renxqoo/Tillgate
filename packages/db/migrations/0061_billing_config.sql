-- 0061：计费配置列——模型映射的可扩展定价参数（策略 + 变体价格表 + 将来阶梯/混合）。
-- 策略词表：flat（缺省，unitPrice 列直接生效）/ variant（按请求参数选价）/ 将来 tiered / hybrid。
-- 与 pricingUnit 正交：pricingUnit 决定计量维度，billingConfig 决定单价怎么选/算。
alter table "model_mappings" add column if not exists "billing_config" jsonb not null default '{}'
