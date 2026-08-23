-- 0077：模型映射逻辑删除（回收站）
-- deleted_at NULL = 在册；非空 = 已删除（记录保留，历史计费/渠道绑定可追溯）。
-- 删除动词在应用层同时强制 status=1（网关热路径 status=0 过滤天然排除）。
-- 外部名唯一索引改部分索引（WHERE deleted_at IS NULL）：已删除记录不占用外部名，
-- 可重建/再导入同名映射。幂等：ADD COLUMN IF NOT EXISTS + DROP/CREATE IF EXISTS。
-- 既有在册行 deleted_at 均为 NULL，唯一索引收窄无数据风险。

--> statement-breakpoint
ALTER TABLE model_mappings ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

--> statement-breakpoint
DROP INDEX IF EXISTS model_mappings_external_name_uq;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS model_mappings_external_name_uq
  ON model_mappings (external_name)
  WHERE deleted_at IS NULL;
