-- 0078：供应商逻辑删除（回收站）——与 0077 模型映射同语义
-- deleted_at NULL = 在册；非空 = 已删除（历史渠道 FK 引用不受影响）。
-- 删除动词在应用层同时强制 status=1；名称唯一索引改部分索引（WHERE deleted_at IS NULL）：
-- 已删除记录不占用名称，可重建同名供应商。幂等：ADD COLUMN IF NOT EXISTS + DROP/CREATE。
-- 既有在册行 deleted_at 均为 NULL，唯一索引收窄无数据风险。

--> statement-breakpoint
ALTER TABLE providers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

--> statement-breakpoint
DROP INDEX IF EXISTS providers_name_uq;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS providers_name_uq
  ON providers (name)
  WHERE deleted_at IS NULL;
