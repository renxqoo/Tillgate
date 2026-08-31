-- 免费定价单源化（docs/free-by-price.md）：删除与价格平行的两个免费标记列。
-- 免费自本迁移起 = 价格取值（模型五轴全 0 → 免费模型；绑定成本 0/NULL → 进货记 0），
-- isFree 在 API 面退化为推导属性。两列的存量值均为价格推导快照/等价语义，无需保真。
ALTER TABLE model_mappings DROP COLUMN IF EXISTS is_free;
ALTER TABLE model_channels DROP COLUMN IF EXISTS cost_is_free;
