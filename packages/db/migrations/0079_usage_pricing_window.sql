-- 0079：用量明细分时段计价审计列
-- usage_logs.pricing_window：本笔账命中的计价时段标签（schedule 策略窗口的 label，
-- 缺省 "start-end" 串）——对账/客诉时「这笔为什么是这个价」一查便知。
-- NULL = 无时段策略 / 未命中窗口 / 历史行（策略上线前）。幂等：ADD COLUMN IF NOT EXISTS。

--> statement-breakpoint
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS pricing_window varchar(64);
