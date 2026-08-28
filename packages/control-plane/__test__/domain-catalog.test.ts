/**
 * 目录纯函数：
 * 对外名建议 / OpenAI 兼容全量映射 / models.dev 字典映射 / 换算 / 三态 diff / 消失检测。
 */
import { describe, expect, it } from 'vitest';
import { defined } from './defined';
import {
  suggestExternalName,
  mapOpenAiCompatibleCatalog,
  mapModelsDevCatalog,
} from '../src/domain/catalog/catalog';
import { compareCatalog, goneFromCatalog } from '../src/domain/catalog/compare';
import { toCny } from '../src/domain/catalog/convert';

const RAW_CATALOG = {
  data: [
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      name: 'Llama 3.3 70B Instruct',
      context_length: 65536,
      pricing: { prompt: '0', completion: '0' },
    },
    {
      id: 'qwen/qwen-2.5-72b-instruct:free',
      name: 'Qwen2.5 72B',
      context_length: 32768,
      pricing: { prompt: '0', completion: '0' },
    },
    {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      pricing: { prompt: '0.0000025', completion: '0.00001', cache_read: '0.00000125' },
    },
  ],
};

const RAW_MODELS_DEV = {
  __meta: { schema: 'https://models.dev' },
  anthropic: {
    models: {
      'claude-sonnet-4': {
        name: 'Claude Sonnet 4',
        limit: { context: 200_000 },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
};

describe('suggestExternalName：去厂商前缀与 :free 后缀', () => {
  it.each([
    ['a/b/c:free', 'c'],
    ['solo-model:free', 'solo-model'],
    ['meta-llama/llama-3.3-70b-instruct:free', 'llama-3.3-70b-instruct'],
  ])('%s → %s', (input, expected) => {
    expect(suggestExternalName(input)).toBe(expected);
  });
});

describe('mapOpenAiCompatibleCatalog：全量返回（免费+付费），币种与缓存价透传', () => {
  it('每 token 价 ×1e6 归一每百万；负价哨兵剔除；垃圾形状返回 []', () => {
    const items = mapOpenAiCompatibleCatalog(RAW_CATALOG, { currency: 'USD' });
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      realModel: 'meta-llama/llama-3.3-70b-instruct:free',
      suggestedName: 'llama-3.3-70b-instruct',
      contextLength: 65536,
    });
    const paid = defined(items.find((i) => i.realModel === 'openai/gpt-4o'));
    expect(paid.catalogPrompt).toBe('2.5');
    expect(paid.catalogCacheRead).toBe('1.25');
    expect(paid.catalogCacheWrite).toBeNull();
    expect(mapOpenAiCompatibleCatalog({}, { currency: 'USD' })).toEqual([]);
    expect(mapOpenAiCompatibleCatalog({ data: 'not-array' }, { currency: 'USD' })).toEqual([]);
  });

  it('不可定价哨兵（pricing -1，如 openrouter/auto-*）不入货架', () => {
    const items = mapOpenAiCompatibleCatalog(
      { data: [{ id: 'openrouter/auto-beta', pricing: { prompt: '-1', completion: '-1' } }] },
      { currency: 'USD' },
    );
    expect(items).toEqual([]);
  });

  it('realModelPrefix 前缀注入（渠道命名空间隔离）', () => {
    const items = mapOpenAiCompatibleCatalog(
      { data: [{ id: 'gpt-4o', pricing: { prompt: 0, completion: 0 } }] },
      { currency: 'USD', realModelPrefix: 'openrouter/' },
    );
    expect(defined(items[0]).realModel).toBe('openrouter/gpt-4o');
  });
});

describe('mapModelsDevCatalog：provider/id 唯一化 + limit.context + cost 四价；__meta 跳过', () => {
  it('标准形状全量映射；负价哨兵剔除；非对象输入返回 []', () => {
    const items = mapModelsDevCatalog(RAW_MODELS_DEV);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      realModel: 'anthropic/claude-sonnet-4',
      displayName: 'Claude Sonnet 4',
      contextLength: 200_000,
      currency: 'USD',
      catalogPrompt: '3',
      catalogCompletion: '15',
      catalogCacheRead: '0.3',
      catalogCacheWrite: '3.75',
    });
    expect(mapModelsDevCatalog(null)).toEqual([]);
    expect(mapModelsDevCatalog('garbage')).toEqual([]);
    expect(
      mapModelsDevCatalog({ x: { models: { bad: { cost: { input: -1, output: 0 } } } } }),
    ).toEqual([]);
  });
});

describe('toCny：唯一换算点（CNY 原样；无汇率 null）', () => {
  it('USD × 生效汇率；12 位有效数字', () => {
    expect(toCny('2.5', 'USD', '7.2')).toBe('18');
    expect(toCny('3', 'CNY', null)).toBe('3');
    expect(toCny('2.5', 'USD', null)).toBeNull();
  });
});

describe('compareCatalog：三态 diff + 漂移 + 免费警告', () => {
  const existing = [
    {
      externalName: 'same-alias',
      realModel: 'openai/gpt-4o',
      inputPrice: '2.5',
      outputPrice: '10',
    },
    {
      externalName: 'free-alias',
      realModel: 'meta-llama/llama-3.3-70b-instruct:free',
      inputPrice: '0',
      outputPrice: '0',
    },
    {
      externalName: 'cheap-alias',
      realModel: 'qwen/qwen-2.5-72b-instruct:free',
      inputPrice: '1000',
      outputPrice: '1000',
    },
  ];

  it('同价 same / 涨价 price_up / 降价 price_down；漂移百分比一位小数', () => {
    const items = mapOpenAiCompatibleCatalog(RAW_CATALOG, { currency: 'USD' });
    const compared = compareCatalog(items, existing, { effectiveRate: '1' });
    const byReal = new Map(compared.map((c) => [c.realModel, c]));
    // gpt-4o 目录 2.5/10 vs 库内 2.5/10 → same
    expect(defined(byReal.get('openai/gpt-4o')).diff).toBe('same');
    expect(defined(byReal.get('openai/gpt-4o')).driftPct).toBe(0);
    expect(defined(byReal.get('openai/gpt-4o')).imported).toMatchObject({
      externalName: 'same-alias',
    });
    // qwen 目录 0/0 vs 库内 1000/1000：目录免费 → catalogCharged=false → same + isFree
    expect(defined(byReal.get('qwen/qwen-2.5-72b-instruct:free')).diff).toBe('same');
    expect(defined(byReal.get('qwen/qwen-2.5-72b-instruct:free')).isFree).toBe(true);
  });

  it('汇率缺失 → diff 退化为 same（无法同币比较）', () => {
    const items = mapOpenAiCompatibleCatalog(RAW_CATALOG, { currency: 'USD' });
    const compared = compareCatalog(items, existing, { effectiveRate: null });
    expect(compared.every((c) => c.diff === 'same' || c.diff === 'new')).toBe(true);
  });

  it('目录收费而我们免费卖 → priceWarning 亏钱警告；未导入 → new', () => {
    const items = mapOpenAiCompatibleCatalog(RAW_CATALOG, { currency: 'USD' });
    // llama 目录免费、库内免费 → 无警告；构造一个目录收费但库内免费的对照
    const custom = [
      { ...defined(items.find((i) => i.realModel === 'openai/gpt-4o')) },
      {
        realModel: 'fresh/model',
        displayName: 'x',
        contextLength: null,
        currency: 'USD' as const,
        catalogPrompt: '1',
        catalogCompletion: '1',
        catalogCacheRead: null,
        catalogCacheWrite: null,
        suggestedName: 'model',
      },
    ];
    const compared = compareCatalog(
      custom,
      [
        {
          externalName: 'free-alias',
          realModel: 'openai/gpt-4o',
          inputPrice: '0',
          outputPrice: '0',
        },
      ],
      { effectiveRate: '1' },
    );
    expect(defined(compared[0]).priceWarning).toBe(true);
    expect(defined(compared[0]).diff).toBe('same');
    expect(defined(compared[1]).diff).toBe('new');
    expect(defined(compared[1]).imported).toBeNull();
  });

  it('±5% 带宽内视为 same；越界判涨/跌', () => {
    const item = {
      realModel: 'm',
      displayName: 'm',
      contextLength: null,
      currency: 'CNY' as const,
      catalogPrompt: '10.4',
      catalogCompletion: '10.4',
      catalogCacheRead: null,
      catalogCacheWrite: null,
      suggestedName: 'm',
    };
    const ours = [{ externalName: 'a', realModel: 'm', inputPrice: '10', outputPrice: '10' }];
    expect(defined(compareCatalog([item], ours, { effectiveRate: '1' })[0]).diff).toBe('same'); // +4%
    const up = { ...item, catalogPrompt: '11', catalogCompletion: '11' };
    expect(defined(compareCatalog([up], ours, { effectiveRate: '1' })[0]).diff).toBe('price_up'); // +10%
    const down = { ...item, catalogPrompt: '8', catalogCompletion: '8' };
    expect(defined(compareCatalog([down], ours, { effectiveRate: '1' })[0]).diff).toBe(
      'price_down',
    ); // -20%
  });
});

describe('goneFromCatalog：上游消失检测', () => {
  it('库内有而目录无的绑定映射 → 消失行', () => {
    const existing = [
      { mappingId: 1, externalName: 'a', realModel: 'a' },
      { mappingId: 2, externalName: 'b', realModel: 'b' },
    ];
    const gone = goneFromCatalog(existing, new Set(['a']));
    expect(gone).toEqual([{ mappingId: 2, externalName: 'b', realModel: 'b' }]);
  });
});
