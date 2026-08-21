-- 0075：usage_logs 渠道 TTFT 聚合的部分索引（channelTtftStats 查询路径）
-- 只追加的大表无 created_at 领头索引，聚合 WHERE 原为顺序扫描；
-- 部分索引仅覆盖流式成功样本（聚合的精确口径），体量小且随写入自然维护。

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_logs_ttft_channel
  ON usage_logs (channel_id, created_at)
  WHERE status = 0 AND stream = true AND client_ttft_ms IS NOT NULL;
