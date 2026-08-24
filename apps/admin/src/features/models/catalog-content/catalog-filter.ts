// 目录货架纯逻辑域：条目/草稿契约 + 筛选三维合取 + diff 徽章词表（无 React 依赖）

export interface CatalogItem {
  realModel: string;
  displayName: string;
  contextLength: number | null;
  currency: 'USD' | 'CNY';
  catalogPrompt: string;
  catalogCompletion: string;
  suggestedName: string;
  imported: { externalName: string; inputPrice: string; outputPrice: string } | null;
  diff: 'new' | 'same' | 'price_up' | 'price_down';
  driftPct: number | null;
  isFree: boolean;
  priceWarning: boolean;
  prefillInputCny: string | null;
  prefillOutputCny: string | null;
}

/** 行内草稿（勾选/对外名/价格组），按 realModel 键存于编排器，跨页/筛选不丢 */
export interface Draft {
  selected: boolean;
  externalName: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
  contextLength: string;
}

export type PriceFilter = 'all' | 'free' | 'paid';
export type StateFilter = 'all' | 'new' | 'changed' | 'imported';

// 徽章样式留模块级；label 是 modelMarket 命名空间的 i18n key，渲染处用 t 解析
export const DIFF_BADGE_CLASS: Record<CatalogItem['diff'], string | null> = {
  new: 'bg-muted text-muted-foreground',
  same: null,
  price_up: 'bg-amber-500/15 text-amber-600',
  price_down: 'bg-emerald-500/15 text-emerald-600',
};

export const DIFF_BADGE_KEY: Partial<Record<CatalogItem['diff'], string>> = {
  new: 'badgeNew',
  price_up: 'badgePriceUp',
  price_down: 'badgePriceDown',
};

/** 搜索命中：q 命中 realModel/展示名/建议名任一（q 已 trim+lowercase；空串全命中） */
function matchesSearch(item: CatalogItem, q: string): boolean {
  return (
    q === '' ||
    item.realModel.toLowerCase().includes(q) ||
    item.displayName.toLowerCase().includes(q) ||
    item.suggestedName.toLowerCase().includes(q)
  );
}

/** 价格筛选：free = 仅免费；paid = 仅付费 */
function matchesPriceFilter(item: CatalogItem, priceFilter: PriceFilter): boolean {
  if (priceFilter === 'free') return item.isFree;
  if (priceFilter === 'paid') return !item.isFree;
  return true;
}

/** 状态筛选：new / changed（涨或跌）/ imported 逐类判定 */
function matchesStateFilter(item: CatalogItem, stateFilter: StateFilter): boolean {
  if (stateFilter === 'new') return item.diff === 'new';
  if (stateFilter === 'changed') return item.diff === 'price_up' || item.diff === 'price_down';
  if (stateFilter === 'imported') return item.imported != null;
  return true;
}

/** 目录筛选条件（搜索词 × 价格 × 状态） */
interface CatalogFilter {
  query: string;
  priceFilter: PriceFilter;
  stateFilter: StateFilter;
}

/** 目录筛选主入口：搜索 × 价格 × 状态三维合取 */
export function filterItems(items: CatalogItem[], filter: CatalogFilter): CatalogItem[] {
  const q = filter.query.trim().toLowerCase();
  return items.filter(
    (i) =>
      matchesSearch(i, q) &&
      matchesPriceFilter(i, filter.priceFilter) &&
      matchesStateFilter(i, filter.stateFilter),
  );
}
