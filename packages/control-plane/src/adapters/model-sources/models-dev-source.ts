/**
 * models.dev 目录源（reference 字典型：不建渠道，导入落草稿；本地快照零网络——
 * 在线源被墙/不可达不影响货架）。价格 $/1M，与 OpenRouter 归一口径一致。
 * 快照刷新：仓根 `bun scripts/fetch-models-dev.ts`（重写 models-dev-snapshot.json）。
 */
import { createRequire } from 'node:module';
import { mapModelsDevCatalog } from '../../domain/catalog/catalog';
import type { CatalogSource } from '../../ports/catalog-source';

// createRequire + require 装载：快照按 unknown 契约消费（mapModelsDevCatalog 接受 unknown），
// 不走 resolveJsonModule——避免 tsc 对 4MB JSON 做结构类型推导（typecheck 门禁的确定性）。
const require = createRequire(import.meta.url);
const MODELS_DEV_SNAPSHOT: unknown = require('./models-dev-snapshot.json');

export const modelsDevSource: CatalogSource = {
  id: 'models-dev',
  name: 'models.dev（参考字典）',
  kind: 'reference',
  priceCurrency: 'USD',
  fetchModels: async () => MODELS_DEV_SNAPSHOT,
  mapModels: (raw) => mapModelsDevCatalog(raw),
};
