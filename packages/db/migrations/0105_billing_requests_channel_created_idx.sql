-- billing_requests 渠道维窗口索引：智能路由观测聚合（routing-overview 按
-- channel_id + created_at 窗口预聚合）此前只能走 status 前导索引做顺序扫描，
-- 观测页默认 1h 窗口对每请求一行的高写入表代价随流量线性放大。
-- 代价权衡：该表写入频繁，新增单列组合索引会带来常驻写放大——由此前的
-- 无 channel 维索引路径评估后接受（观测页为管理台低频读路径）。
-- 回滚：DROP INDEX IF EXISTS "billing_requests_channel_created_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_requests_channel_created_idx"
  ON "billing_requests" ("channel_id", "created_at");
