-- 0079：渠道逻辑删除（回收站）——与 0077/0078（模型映射/供应商）同语义
-- deleted_at NULL = 在册；非空 = 已删除（历史绑定/资金流水/FK 引用保留可追溯）。
-- 删除动词在应用层同时强制 status=1（路由 status=0 过滤天然排除）；恢复记录回禁用态。
-- 渠道名唯一索引改部分索引（WHERE deleted_at IS NULL）：已删除记录不占用渠道名。
-- 幂等：ADD COLUMN IF NOT EXISTS + DROP/CREATE IF EXISTS；既有在册行唯一索引收窄无数据风险。

--> statement-breakpoint
ALTER TABLE channels ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

--> statement-breakpoint
DROP INDEX IF EXISTS channels_name_uq;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS channels_name_uq
  ON channels (name)
  WHERE deleted_at IS NULL;
