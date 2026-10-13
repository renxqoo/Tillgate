-- 密度观测轴（C7b 删除的替代感知面——非门禁）：prefix_bytes 与 input_tokens
-- 的时间序列比可离线判别「低报中转 vs 缓存 miss」。存量行回填 0（观测从新行开始）。
ALTER TABLE prefix_calibrations ADD COLUMN prefix_bytes bigint NOT NULL DEFAULT 0;
