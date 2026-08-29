-- 绑定级上游模型名 + 生成任务出站名快照（一次建模、多渠道异名）：
--   model_mappings.realModel 保持「能力规范名」（身份/计费/统计/别名共享路由键），
--   model_channels.upstream_model 成为发往该渠道的真实模型名（热路径出站名单一来源）。
--   generation_tasks.upstream_model 为提交时快照（worker 代执行构造请求用，
--   在途任务不随绑定改名漂移；回填取绑定行名，绑定已删的孤儿行回落映射 realModel）。
-- 白名单收口：channels.models 自本迁移起在 findRouteCandidates 按绑定 upstream_model
--   取交集（NULL/空数组 = 不限）——与列注释语义对齐。
-- 注：任务表回填用标量子查询——UPDATE...FROM 的 JOIN ON 里引用目标表是 PG 语法禁区
-- （invalid reference to FROM-clause entry；曾因此使 drizzle migrate 在有数据的库上失败）。
-- 回滚：ALTER TABLE model_channels DROP COLUMN upstream_model;
--       ALTER TABLE generation_tasks DROP COLUMN upstream_model;
ALTER TABLE "model_channels" ADD COLUMN "upstream_model" varchar(128);
--> statement-breakpoint
UPDATE "model_channels" mc SET "upstream_model" = mm."real_model"
FROM "model_mappings" mm
WHERE mm."id" = mc."mapping_id";
--> statement-breakpoint
ALTER TABLE "model_channels" ALTER COLUMN "upstream_model" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD COLUMN "upstream_model" varchar(128);
--> statement-breakpoint
UPDATE "generation_tasks" gt SET "upstream_model" = (
  SELECT COALESCE(mc."upstream_model", mm."real_model")
  FROM "model_mappings" mm
  LEFT JOIN "model_channels" mc ON mc."mapping_id" = gt."mapping_id" AND mc."channel_id" = gt."channel_id"
  WHERE mm."id" = gt."mapping_id"
);
--> statement-breakpoint
ALTER TABLE "generation_tasks" ALTER COLUMN "upstream_model" SET NOT NULL;
