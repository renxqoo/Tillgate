-- 0107: 路由排序 weight/priority 收口渠道层（用户裁决 D4）
-- model_channels 的绑定级 weight/priority 从无 UI 入口（恒缺省 1/0），
-- 路由实际读取已切换为 channels.weight/priority（渠道管理页可编辑）。
-- 无数据迁移：绑定级恒缺省值，不存在需要保留的事实。
ALTER TABLE model_channels DROP COLUMN IF EXISTS weight;
ALTER TABLE model_channels DROP COLUMN IF EXISTS priority;
