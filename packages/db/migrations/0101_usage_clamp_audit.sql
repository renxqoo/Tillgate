-- 0101：usage_logs 用量钳制审计列（结算验收门「发票 → 验收」轨迹）。
-- 结算时上游发票（trusted usage）超出准入界（quote 的 inputTokenUpperBound /
-- maxOutputTokens）或证据界（响应字节）被 acceptTrustedUsage 钳定的，把每条钳制
-- 事实（kind/field/original/clamped/bound，单一真相在 billing usage-acceptance）
-- 以 jsonb 数组落列；NULL = 诚实发票或估算收据（未发生钳制）。
-- 背景钳制现状只走渠道缺陷计数（0098），对账/客诉「这笔 usage 为什么与响应
-- 不一致」缺少行级审计口径。纯增量列，无回填（历史行 = 无钳制事实 = NULL）。
alter table usage_logs
  add column if not exists usage_clamps jsonb;
