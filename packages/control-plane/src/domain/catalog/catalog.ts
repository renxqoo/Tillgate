/**
 * 模型目录域契约与纯函数（v1 admin-api domain/catalog.ts 等价迁移）：
 * 目录源货架（全量，免费/付费由消费方筛）+ 库内三态 diff + 换算 + 消失检测 + 对外名建议。
 * 目录 = 临时货架（内存缓存，不落库）；导入落的是既有三层 provider/channel/model_mappings。
 */
import Decimal from 'decimal.js';

export type CatalogCurrency = 'USD' | 'CNY';

/** 目录价与库内卖价的差异态（换算同币后比较，5% 带宽抗汇率噪声） */
export type CatalogDiffState = 'new' | 'same' | 'price_up' | 'price_down';

export interface CatalogItem {
  /** 上游真实模型 id（channel 源）或 provider/id 唯一化（reference 源） */
  realModel: string;
  displayName: string;
  contextLength: number | null;
  currency: CatalogCurrency;
  /** 目录参考输入价（源币种/百万 token；字符串保形，"0"=免费） */
  catalogPrompt: string;
  catalogCompletion: string;
  catalogCacheRead: string | null;
  catalogCacheWrite: string | null;
  /** 对外名建议（去厂商前缀与 :free 后缀） */
  suggestedName: string;
}

export interface CatalogComparison extends CatalogItem {
  /** 已导入回填（我们的卖价，CNY） */
  imported: { externalName: string; inputPrice: string; outputPrice: string } | null;
  diff: CatalogDiffState;
  /** 目录换算价相对我们卖价的偏离（%，正=上游比我们贵）；无法判定为 null */
  driftPct: number | null;
  /** 免费判定：目录输入输出价均为 0（:free 变体公开特征；CNY 源同构） */
  isFree: boolean;
  /** 目录收费而我们免费卖 → 亏钱风险，页面标红 */
  priceWarning: boolean;
}

/** 对外名建议：`meta-llama/llama-3.3-70b-instruct:free` → `llama-3.3-70b-instruct` */
export function suggestExternalName(id: string): string {
  const stripped = id.replace(/:free$/, '');
  const segments = stripped.split('/');
  return (segments.at(-1) || stripped).slice(0, 64);
}

function asPrice(v: unknown): string {
  if (!((typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v)))) {
    return '0';
  }
  try {
    const value = new Decimal(v);
    return value.isFinite() ? value.toString() : '0';
  } catch {
    return '0';
  }
}

function asOptionalPrice(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = asPrice(v);
  return new Decimal(s).gt(0) ? s : null;
}

/** 目录展示保留 12 位有效数字；运算始终走 Decimal，不引入 IEEE-754 尾差。 */
function cleanPrice(n: string | number | Decimal): string {
  return new Decimal(n).toSignificantDigits(12).toString();
}

/** 上游「不可定价」哨兵（OpenRouter auto-* 与 models.dev 均用负值/-1）：缺省/0 不是哨兵 */
export function isUnpriceableSentinel(v: unknown): boolean {
  return new Decimal(asPrice(v)).lt(0);
}

/** 每 token 价 → 每百万价（0/缺省保持 null——免费无缓存价语义） */
function scalePerMillion(v: unknown, perMillion: Decimal): string | null {
  const s = asOptionalPrice(v);
  return s == null ? null : cleanPrice(new Decimal(s).times(perMillion));
}

/** 每 token 与每百万的换算因子（目录价量纲归一——OpenRouter 口径 → models.dev 口径） */
const PER_TOKEN_TO_PER_MILLION = new Decimal('1000000');

/**
 * OpenAI 兼容 models 列表 → 全量目录（OpenRouter/SiliconFlow/Groq 同构）。
 * 免费过滤已上移到消费方（UI 筛选「免费/全部」）——付费入库链路本就完整。
 * 价格口径归一：/v1/models 的 pricing 为「每 token 美元」，统一换算成「每百万 token」
 * （×1e6）——与 models.dev 的 cost 口径一致，预填/比价不再有量纲差。
 * 不可定价哨兵（pricing 为 -1，如 openrouter/auto-beta 动态定价）不入货架：
 * 预填无依据、且负价会在换算/比价里疯走——导入需运营自行配价。
 */
// eslint-disable-next-line complexity -- 外部目录形状防御式映射,分支来自垃圾形状枚举
export function mapOpenAiCompatibleCatalog(
  raw: unknown,
  opts: { currency: CatalogCurrency; realModelPrefix?: string },
): CatalogItem[] {
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
    if (
      isUnpriceableSentinel(row.pricing?.prompt) ||
      isUnpriceableSentinel(row.pricing?.completion)
    ) {
      continue;
    }
    const prompt = new Decimal(asPrice(row.pricing?.prompt));
    const completion = new Decimal(asPrice(row.pricing?.completion));
    const realModel = opts.realModelPrefix ? `${opts.realModelPrefix}${row.id}` : row.id;
    items.push({
      realModel,
      displayName: typeof row.name === 'string' ? row.name : row.id,
      contextLength: typeof row.context_length === 'number' ? row.context_length : null,
      currency: opts.currency,
      catalogPrompt: cleanPrice(prompt.times(PER_TOKEN_TO_PER_MILLION)),
      catalogCompletion: cleanPrice(completion.times(PER_TOKEN_TO_PER_MILLION)),
      catalogCacheRead: scalePerMillion(
        (row.pricing as { cache_read?: unknown } | undefined)?.cache_read,
        PER_TOKEN_TO_PER_MILLION,
      ),
      catalogCacheWrite: scalePerMillion(
        (row.pricing as { cache_write?: unknown } | undefined)?.cache_write,
        PER_TOKEN_TO_PER_MILLION,
      ),
      suggestedName: suggestExternalName(row.id),
    });
  }
  return items;
}

/**
 * models.dev api.json → 全量参考目录（字典型源；导入落草稿 + 按 provider 前缀
 * find-or-create 对应渠道，见 application/catalog/import-catalog.ts）。
 * 形状：{ [provider]: { models: { [id]: { name, limit.context, cost.{input,output,cache_read,cache_write} } } } }
 * 负价哨兵（不可定价）不入货架——与 OpenAI 兼容源同语义；缺 cost 保持 0（免费口径不变）。
 */
// eslint-disable-next-line complexity -- models.dev 形状防御式映射,分支来自垃圾形状枚举
export function mapModelsDevCatalog(raw: unknown): CatalogItem[] {
  const data = raw as Record<string, { models?: Record<string, Record<string, unknown>> }> | null;
  if (!data || typeof data !== 'object') return [];
  const items: CatalogItem[] = [];
  for (const [provider, pd] of Object.entries(data)) {
    if (provider === '__meta' || provider === '$schema') continue;
    for (const [id, m] of Object.entries(pd.models ?? {})) {
      if (typeof id !== 'string' || id.length === 0) continue;
      const limit = (m.limit ?? {}) as { context?: unknown };
      const cost = (m.cost ?? {}) as Record<string, unknown>;
      if (isUnpriceableSentinel(cost.input) || isUnpriceableSentinel(cost.output)) continue;
      items.push({
        realModel: `${provider}/${id}`,
        displayName: typeof m.name === 'string' && m.name ? m.name : id,
        contextLength:
          typeof limit.context === 'number' && limit.context > 0 ? limit.context : null,
        currency: 'USD',
        catalogPrompt: cleanPrice(asPrice(cost.input)),
        catalogCompletion: cleanPrice(asPrice(cost.output)),
        catalogCacheRead: asOptionalPrice(cost.cache_read),
        catalogCacheWrite: asOptionalPrice(cost.cache_write),
        suggestedName: suggestExternalName(id),
      });
    }
  }
  return items;
}
