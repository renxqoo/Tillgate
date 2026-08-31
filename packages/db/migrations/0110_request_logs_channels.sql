-- request_logs 渠道轨迹列（排障：失败请求碰了哪些渠道、按什么顺序——含被门
-- 拒绝的渠道；成功请求=最终服务渠道收尾）。0039 删掉的 candidates_tried 是
-- 「从未被写入」的死列；本列配套完整写入/查询/展示链路。
-- 分区母表 ALTER 自动传播到各子分区（PARTITION BY RANGE 声明式分区语义）。
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS channels jsonb;
