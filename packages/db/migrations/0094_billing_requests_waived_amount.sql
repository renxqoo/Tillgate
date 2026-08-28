-- 0094：结算超收放弃额列。
-- 背景：actual > 预留且可用额不足时，#over 补扣与账本一致性触发器
-- （user 账户 balance + credit_limit − in_flight >= 0）矛盾——结算事务必然
-- 失败，重试耗尽进 dead（预扣冻结 + 无 usage 落账 + 用户已拿到响应）。
-- 修复语义：超收钳制到可收额（available 口径），差额记入本列；结算恒成功。
ALTER TABLE billing_requests
  ADD COLUMN IF NOT EXISTS waived_amount numeric(38, 18) NOT NULL DEFAULT '0';

-- 历史死信的放弃额不可回填（实扣口径已不可考），保持 0；复核面按需人工处理。
