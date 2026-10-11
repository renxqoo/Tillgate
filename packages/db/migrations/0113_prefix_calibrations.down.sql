-- 0113 回滚（方案 §9 回滚阶梯的最后一步：先 KV 排空在途，再 revert 代码，
-- 最后本迁移）。校准记录是可重建的派生事实（结算重新积累），无数据保留义务。
DROP INDEX IF EXISTS prefix_calibrations_recent_idx;
DROP TABLE IF EXISTS prefix_calibrations;
ALTER TABLE billing_requests DROP COLUMN IF EXISTS conservative_channel_amount;
DELETE FROM system_configs WHERE key = 'billing_calibration';
