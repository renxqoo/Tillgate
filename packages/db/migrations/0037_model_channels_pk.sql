-- A8 结构化收口：model_channels 的复合主键 (mapping_id, channel_id)。
-- schema.ts 一直声明该 PK，但历史迁移从未落库（快照亦未跟踪此表）——
-- 没有主键 = 同一映射可重复绑定同一渠道（并发导入双行）、且无法作为
-- ON CONFLICT 仲裁者。存量无重复行（已核），直接补建。
ALTER TABLE "model_channels" ADD CONSTRAINT "model_channels_pk" PRIMARY KEY ("mapping_id", "channel_id");
