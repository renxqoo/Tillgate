-- 0108: 渠道成本价双轨定价（docs/channel-cost-pricing.md）
-- model_channels 绑定级成本覆盖：NULL = 继承映射官方价（读取处 COALESCE 收口，零回填）。
-- cost_config 与映射 billing_config 同构（schedule 峰谷成本窗口等策略由 billing 解析器复用）。
ALTER TABLE "model_channels"
  ADD COLUMN "cost_input_price" numeric(38, 18),
  ADD COLUMN "cost_output_price" numeric(38, 18),
  ADD COLUMN "cost_cache_input_price" numeric(38, 18),
  ADD COLUMN "cost_cache_write_price" numeric(38, 18),
  ADD COLUMN "cost_unit_price" numeric(38, 18),
  ADD COLUMN "cost_config" jsonb NOT NULL DEFAULT '{}';

-- 负成本在入口即拒绝（钳 0 会静默免费）；NULL 继承不触发约束
ALTER TABLE "model_channels"
  ADD CONSTRAINT "model_channels_cost_nonnegative_ck"
  CHECK (
    "cost_input_price" IS NULL OR (
      "cost_input_price" >= 0 AND "cost_output_price" >= 0
      AND "cost_cache_input_price" >= 0 AND "cost_cache_write_price" >= 0
      AND "cost_unit_price" >= 0
    )
  );
