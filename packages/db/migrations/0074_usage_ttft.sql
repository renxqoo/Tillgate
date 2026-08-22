-- 0074：usage_logs 首字延迟观测列（流式专属，不参与计费）
-- upstream_ttft_ms = 上游尝试开始→上游首字节；client_ttft_ms = 管道起点→首字节写给客户端。
-- 幂等：ADD COLUMN IF NOT EXISTS。

--> statement-breakpoint
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS upstream_ttft_ms bigint;

--> statement-breakpoint
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS client_ttft_ms bigint;
