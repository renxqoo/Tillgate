/**
 * 模型目录纯函数（单 app 域）：OpenAI 兼容目录 → 免费模型货架 + 库内比对。
 * 目录 = 临时货架（内存缓存，不落库）；导入落的是既有三层
 * provider/channel/model_mappings，无新概念。
 */
export interface CatalogItem {
  /** 上游真实模型 id（如 meta-llama/llama-3.3-70b-instruct:free） */
  realModel: string;
  displayName: string;
  contextLength: number | null;
  /** 目录参考价（字符串；免费为 "0"）——只展示，不自动成为卖价 */
  catalogPromptUsd: string;
  catalogCompletionUsd: string;
  /** 对外名建议（去厂商前缀与 :free 后缀） */
  suggestedName: string;
}

export interface CatalogComparison extends CatalogItem {
  /** 已导入回填（我们的卖价） */
  imported: { externalName: string; inputPrice: string; outputPrice: string } | null;
  /** 上游目录价 > 0 而我们的卖价 = 0 → 亏钱风险，页面标红 */
  priceWarning: boolean;
}

/** 对外名建议：`meta-llama/llama-3.3-70b-instruct:free` → `llama-3.3-70b-instruct` */
export function suggestExternalName(id: string): string {
  const stripped = id.replace(/:free$/, '');
  const segments = stripped.split('/');
  return (segments[segments.length - 1] || stripped).slice(0, 64);
}

/** OpenAI 兼容 models 列表 → 免费模型目录（pricing 全 0 判定；OpenRouter/SiliconFlow 同构） */
export function mapOpenAiCompatibleCatalog(raw: unknown): CatalogItem[] {
  const data = (raw as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const items: CatalogItem[] = [];
  for (const m of data) {
    const row = m as {
      id?: unknown;
      name?: unknown;
      context_length?: unknown;
      pricing?: { prompt?: unknown; completion?: unknown };
    };
    if (typeof row.id !== 'string' || row.id.length === 0) continue;
    const prompt = typeof row.pricing?.prompt === 'string' ? row.pricing.prompt : '';
    const completion = typeof row.pricing?.completion === 'string' ? row.pricing.completion : '';
    // 免费判定：输入输出目录价均为 0（:free 变体的公开特征）
    if (prompt !== '0' || completion !== '0') continue;
    items.push({
      realModel: row.id,
      displayName: typeof row.name === 'string' ? row.name : row.id,
      contextLength: typeof row.context_length === 'number' ? row.context_length : null,
      catalogPromptUsd: prompt,
      catalogCompletionUsd: completion,
      suggestedName: suggestExternalName(row.id),
    });
  }
  return items;
}

/** 目录 × 库内映射 → 回填已导入状态与漂移警告（纯函数） */
export function compareCatalog(
  items: readonly CatalogItem[],
  existing: ReadonlyArray<{
    externalName: string;
    realModel: string;
    inputPrice: string;
    outputPrice: string;
  }>,
): CatalogComparison[] {
  const byReal = new Map(existing.map((e) => [e.realModel, e]));
  return items.map((item) => {
    const ours = byReal.get(item.realModel) ?? null;
    const catalogCharged =
      Number(item.catalogPromptUsd) > 0 || Number(item.catalogCompletionUsd) > 0;
    const weSellFree =
      ours != null && Number(ours.inputPrice) === 0 && Number(ours.outputPrice) === 0;
    return { ...item, imported: ours, priceWarning: catalogCharged && weSellFree };
  });
}
