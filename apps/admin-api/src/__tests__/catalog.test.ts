/**
 * 模型目录语义（v1 model-catalog + model-catalog.atomic.red 的 v2 对位）：
 *   - 纯函数：对外名建议（去 :free 后缀 + 厂商前缀）/ 免费模型过滤 / 漂移比对
 *   - 导入：find-or-create provider/channel（rpm/额度预填、密钥加密）、
 *     重复导入 = 价格更新确认（isFree 随价格重推导）、外部名冲突 409、
 *     首次缺 key 400、价格必填 400
 *   - M3 red：中途冲突整体回滚——provider/channel/映射/绑定零残留
 *   - 未知源 404；目录源清单
 */
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { Decimal } from '@ai-gateway/domain';
import { channels, modelChannels, modelMappings, providers } from '@ai-gateway/db';
import type { CatalogSource } from '../services/catalog.service.js';
import {
  compareCatalog,
  mapOpenAiCompatibleCatalog,
  suggestExternalName,
} from '../domain/catalog.js';
import {
  buildTestApp,
  db,
  newAdmin,
  trackChannel,
  trackMapping,
  trackProvider,
  uid,
} from './helpers.js';

/** OpenRouter 形状的目录夹具：2 免费 + 1 付费 */
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
      pricing: { prompt: '0.0000025', completion: '0.00001' },
    },
  ],
};

/** 目录导入落库行的清理收编（provider/channel 按源命名；映射按本批对外名） */
async function trackImported(source: CatalogSource, externalNames: readonly string[]): Promise<void> {
  const [p] = await db.select({ id: providers.id }).from(providers).where(eq(providers.name, source.providerName));
  if (p) trackProvider(p.id);
  const [ch] = await db.select({ id: channels.id }).from(channels).where(eq(channels.name, source.channelName));
  if (ch) trackChannel(ch.id);
  if (externalNames.length) {
    const ms = await db
      .select({ id: modelMappings.id })
      .from(modelMappings)
      .where(inArray(modelMappings.externalName, [...externalNames]));
    for (const m of ms) trackMapping(m.id);
  }
}

function mockSource(overrides: Partial<CatalogSource> = {}): CatalogSource {
  return {
    id: 'mock-src',
    name: 'Mock 源',
    providerName: uid('src-prov'),
    providerBaseUrl: 'https://mock.example.com/v1',
    providerProtocol: 'openai-compatible',
    channelName: uid('free-ch'),
    needsKey: true,
    fetchModels: async () => RAW_CATALOG,
    ...overrides,
  };
}

describe('目录纯函数', () => {
  it('suggestExternalName：去厂商前缀与 :free 后缀', () => {
    expect(suggestExternalName('a/b/c:free')).toBe('c');
    expect(suggestExternalName('solo-model:free')).toBe('solo-model');
    expect(suggestExternalName('meta-llama/llama-3.3-70b-instruct:free')).toBe('llama-3.3-70b-instruct');
  });

  it('mapOpenAiCompatibleCatalog：只留免费模型（pricing 全 0）', () => {
    const items = mapOpenAiCompatibleCatalog(RAW_CATALOG);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.realModel)).not.toContain('openai/gpt-4o');
    expect(items[0]).toMatchObject({
      realModel: 'meta-llama/llama-3.3-70b-instruct:free',
      suggestedName: 'llama-3.3-70b-instruct',
      contextLength: 65536,
    });
    expect(mapOpenAiCompatibleCatalog({})).toEqual([]);
  });

  it('compareCatalog：已导入回填卖价；上游收费而我们 0 卖 → priceWarning', () => {
    const items = mapOpenAiCompatibleCatalog(RAW_CATALOG);
    const compared = compareCatalog(items, [
      { externalName: 'llama-3.3-70b-instruct', realModel: 'meta-llama/llama-3.3-70b-instruct:free', inputPrice: '0', outputPrice: '0' },
    ]);
    const imported = compared.find((i) => i.imported != null)!;
    expect(imported.imported!.externalName).toBe('llama-3.3-70b-instruct');
    // 上游免费 + 我们免费 → 无警告
    expect(imported.priceWarning).toBe(false);
    // 上游开始收费（目录价 > 0）而我们仍 0 卖 → 警告
    const drifted = compareCatalog(
      [{ ...items[0]!, catalogPromptUsd: '0.000001', catalogCompletionUsd: '0' }],
      [{ externalName: 'llama-3.3-70b-instruct', realModel: items[0]!.realModel, inputPrice: '0', outputPrice: '0' }],
    );
    expect(drifted[0]!.priceWarning).toBe(true);
  });
});

describe('目录导入（mock 源，真 PG）', () => {
  it('首次导入建 provider/channel/映射/绑定；重复导入复用并更新价格；isFree 随价翻转', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    const externalName = uid('ext');

    const first = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        apiKey: 'sk-or-v1-test',
        models: [
          { externalName, realModel: 'meta-llama/llama-3.3-70b-instruct:free', inputPrice: 0, outputPrice: 0, cacheInputPrice: 0, contextLength: 65536 },
        ],
      },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { providerId: number; channelId: number; created: number; updated: number };
    expect(firstBody).toMatchObject({ created: 1, updated: 0 });
    await trackImported(source, [externalName]);

    // provider 落库（协议/baseUrl 来自源注册表）
    const [provider] = await db.select().from(providers).where(eq(providers.id, firstBody.providerId));
    expect(provider!.name).toBe(source.providerName);
    expect(provider!.baseUrl).toBe(source.providerBaseUrl);

    // 免费渠道：rpm 预填 20、密钥加密（不含明文）
    const [channel] = await db.select().from(channels).where(eq(channels.id, firstBody.channelId));
    expect(Number(channel!.rpmLimit)).toBe(20);
    expect(channel!.apiKeyEnc).toMatch(/^enc:v1:/);
    expect(channel!.apiKeyEnc).not.toContain('sk-or-v1-test');

    // 映射：isFree=true（全零价推导）
    const [mapping] = await db.select().from(modelMappings).where(eq(modelMappings.externalName, externalName));
    expect(mapping!.isFree).toBe(true);
    expect(mapping!.contextLength).toBe(65536);

    // 绑定建立
    const bindings = await db.select().from(modelChannels).where(eq(modelChannels.mappingId, mapping!.id));
    expect(bindings).toHaveLength(1);

    // 重复导入（无 key）复用 provider/channel；价格更新确认；isFree 翻 false
    const second = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        models: [
          { externalName, realModel: 'meta-llama/llama-3.3-70b-instruct:free', inputPrice: 5, outputPrice: 5, cacheInputPrice: 5 },
        ],
      },
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as typeof firstBody;
    expect(secondBody).toMatchObject({ providerId: firstBody.providerId, channelId: firstBody.channelId, created: 0, updated: 1 });
    const [updatedMapping] = await db.select().from(modelMappings).where(eq(modelMappings.externalName, externalName));
    expect(new Decimal(updatedMapping!.inputPrice).eq(5)).toBe(true);
    expect(updatedMapping!.isFree).toBe(false); // R6：随价格重推导
  });

  it('首次导入缺 key → 400 api_key_required', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    const res = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        models: [
          { externalName: 'x', realModel: 'y', inputPrice: 0, outputPrice: 0, cacheInputPrice: 0 },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('api_key_required');
  });

  it('价格必填：缺 inputPrice → 400（zod）', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    const res = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        apiKey: 'sk-x',
        models: [{ externalName: 'x', realModel: 'y', outputPrice: 0, cacheInputPrice: 0 }],
      },
    });
    expect(res.status).toBe(400);
  });

  it('外部名冲突（同对外名绑不同真实模型）→ 409 external_name_conflict', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    // 第一条建立对外名
    const externalName = uid('ext');
    const first = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        apiKey: 'sk-x',
        models: [{ externalName, realModel: uid('real'), inputPrice: 0, outputPrice: 0, cacheInputPrice: 0 }],
      },
    });
    expect(first.status).toBe(200);
    await trackImported(source, [externalName]);
    // 同对外名 + 不同 realModel → 409
    const res = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        models: [{ externalName, realModel: uid('other-real'), inputPrice: 0, outputPrice: 0, cacheInputPrice: 0 }],
      },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('external_name_conflict');
  });
});

describe('M3 red：导入中途冲突整体回滚', () => {
  it('第二批模型冲突 → 409 且无 provider/channel/映射/绑定残留', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    const { newMappingRow } = await import('./helpers.js');

    // 预置冲突：外部名已绑另一个真实模型
    const conflictExt = uid('conflict');
    await newMappingRow({ externalName: conflictExt, realModel: uid('occupied') });

    const newExt = uid('fresh');
    const res = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        apiKey: 'sk-x',
        models: [
          { externalName: newExt, realModel: uid('r1'), inputPrice: 0, outputPrice: 0, cacheInputPrice: 0 },
          { externalName: conflictExt, realModel: uid('r2'), inputPrice: 0, outputPrice: 0, cacheInputPrice: 0 },
        ],
      },
    });
    expect(res.status).toBe(409);

    // 零残留：本批名的 provider/channel/映射全不存在
    const [provider] = await db.select().from(providers).where(eq(providers.name, source.providerName));
    expect(provider).toBeUndefined();
    const [channel] = await db.select().from(channels).where(eq(channels.name, source.channelName));
    expect(channel).toBeUndefined();
    const [mapping] = await db.select().from(modelMappings).where(eq(modelMappings.externalName, newExt));
    expect(mapping).toBeUndefined();
  });

  it('无冲突导入完整落库（回归：事务不破坏正常路径）', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    const externalName = uid('ok');
    const res = await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        apiKey: 'sk-x',
        models: [{ externalName, realModel: uid('r'), inputPrice: 0, outputPrice: 0, cacheInputPrice: 0 }],
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created: number }).created).toBe(1);
    await trackImported(source, [externalName]);
    const [provider] = await db.select().from(providers).where(eq(providers.name, source.providerName));
    expect(provider).toBeTruthy();
  });
});

describe('目录源边界', () => {
  it('未知源 → 404 catalog_source_not_found', async () => {
    const { request } = buildTestApp({ sources: [mockSource()] });
    const { token } = await newAdmin();
    const res = await request('/v1/model-catalog/no-such-source', { token });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('catalog_source_not_found');
  });

  it('源清单回显注册表（id/needsKey/channelName）', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    const res = await request('/v1/model-catalog/sources', { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: Array<{ id: string; needsKey: boolean; channelName: string }> };
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({ id: source.id, needsKey: true, channelName: source.channelName });
  });

  it('比对接口：回填已导入 + 免费渠道就绪探测', async () => {
    const source = mockSource();
    const { request } = buildTestApp({ sources: [source] });
    const { token } = await newAdmin();
    // 先导入一个模型（uid 对外名防撞存量；realModel 对齐目录夹具）
    const externalName = uid('ext');
    await request('/v1/model-catalog/import', {
      token,
      body: {
        sourceId: source.id,
        apiKey: 'sk-x',
        models: [{ externalName, realModel: 'meta-llama/llama-3.3-70b-instruct:free', inputPrice: 0, outputPrice: 0, cacheInputPrice: 0 }],
      },
    });
    await trackImported(source, [externalName]);
    const res = await request(`/v1/model-catalog/${source.id}`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channelReady: boolean;
      channelRpmLimit: number | null;
      items: Array<{ suggestedName: string; imported: unknown; priceWarning: boolean }>;
    };
    expect(body.channelReady).toBe(true);
    expect(body.channelRpmLimit).toBe(20);
    const llama = body.items.find((i) => i.suggestedName === 'llama-3.3-70b-instruct')!;
    expect(llama.imported).toBeTruthy();
    expect(body.items).toHaveLength(2); // 付费的 gpt-4o 不在免费货架
  });
});
