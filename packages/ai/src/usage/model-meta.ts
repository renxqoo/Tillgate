/**
 * 模型元数据解析（contextWindow）：数据快照由 scripts/generate-model-meta.mts
 * 生成（上游 models.dev，离线回落 pi-ai 快照），重跑 `bun run --filter @ai-gateway/ai model-meta` 刷新。
 * 解析顺序：provider:model 精确键 → 裸模型名（冲突时生成器已取更大窗口）。
 */
import { MODEL_CONTEXT_WINDOWS } from './model-meta.generated';

/** 模型上下文窗口（未知模型 → null：元数据缺失时不做溢出判定） */
export function contextWindowOf(providerName?: string, model?: string): number | null {
  if (model) {
    if (providerName) {
      const exact = MODEL_CONTEXT_WINDOWS[`${providerName}:${model}`];
      if (typeof exact === 'number') return exact;
    }
    const bare = MODEL_CONTEXT_WINDOWS[model];
    if (typeof bare === 'number') return bare;
  }
  return null;
}
