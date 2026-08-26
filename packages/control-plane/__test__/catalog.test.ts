/**
 * 目录用例（v1 catalog.test.ts 服务级用例等价迁移，mock 源注入 + 网络零依赖）：
 * 源清单 / comparison（三态+预填+fx 快照+channelReady+gone）/ channel 导入（find-or-create/
 * 重复=价格更新确认/外部名冲突回滚/缺 key 拒绝）/ reference 草稿导入 / provenance 审计全链 / 源缓存 TTL。
 */
import { describe, expect, it } from 'vitest';
import { defined } from './defined';
import { listCatalogSources } from '../src/application/catalog/list-catalog-sources';
import { compareCatalogFromSource } from '../src/application/catalog/compare-catalog';
import { catalogPriceHistory } from '../src/application/catalog/catalog-price-history';
import { importCatalog } from '../src/application/catalog/import-catalog';
import { createMemoryCatalogCache } from '../src/ports/cache';
import type { CatalogSource } from '../src/ports/catalog-source';
import { mapOpenAiCompatibleCatalog, mapModelsDevCatalog } from '../src/domain/catalog/catalog';
import type { FxDeps } from '../src/application/fx/fx-shared';
import {
  adminCtx,
  createMemoryChannelStore,
  createMemoryModelStore,
  createMemoryProviderStore,
  createMemoryAudit,
  createMemoryDb,
  createMemoryFxStore,
  fakeCipher,
} from './memory';

const RAW_CATALOG = {
  data: [
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      name: 'Llama 3.3 70B',
      context_length: 65536,
      pricing: { prompt: '0', completion: '0' },
    },
    {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      pricing: { prompt: '0.0000025', completion: '0.00001' },
    },
  ],
};

const RAW_MODELS_DEV = {
  __meta: {},
  anthropic: {
    models: {
      'claude-sonnet-4': {
        name: 'Claude Sonnet 4',
        limit: { context: 200_000 },
        cost: { input: 3, output: 15 },
      },
    },
  },
  openai: {
    models: {
      'gpt-4o': {
        name: 'GPT-4o',
        limit: { context: 128_000 },
        cost: { input: 2.5, output: 10 },
      },
    },
  },
};

function mockSource(overrides: Partial<CatalogSource> = {}): CatalogSource {
  return {
    id: 'mock-src',
    name: 'Mock 源',
    kind: 'channel',
    priceCurrency: 'USD',
    channel: {
      providerName: 'mock-prov',
      providerBaseUrl: 'https://mock.example.com/v1',
      providerProtocol: 'openai-compatible',
      channelName: 'mock-ch',
      needsKey: true,
    },
    fetchModels: async () => RAW_CATALOG,
    mapModels: (raw) => mapOpenAiCompatibleCatalog(raw, { currency: 'USD' }),
    ...overrides,
  };
}

function mockReferenceSource(): CatalogSource {
  return {
    id: 'mock-ref',
    name: 'Mock 字典',
    kind: 'reference',
    priceCurrency: 'USD',
    fetchModels: async () => RAW_MODELS_DEV,
    mapModels: (raw) => mapModelsDevCatalog(raw),
  };
}

function setup(sources: readonly CatalogSource[], fetchRate: number | 'fail' = 7.2) {
  const db = createMemoryDb();
  const providers = createMemoryProviderStore();
  const channels = createMemoryChannelStore(() => 'mock-prov');
  const models = createMemoryModelStore();
  const audit = createMemoryAudit();
  const fxStateStore = createMemoryFxStore();
  const cache = createMemoryCatalogCache();
  const fxDeps: FxDeps = {
    db,
    stores: { fx: fxStateStore.store },
    audit: audit.sink,
    env: {
      sourceUrl: 'https://fx.example/latest',
      autoTtlMs: 4 * 60 * 60 * 1000,
      fetchTimeoutMs: 10_000,
      fetch:
        fetchRate === 'fail'
          ? ((async () => new Response('boom', { status: 500 })))
          : ((async () =>
              new Response(JSON.stringify({ rates: { CNY: fetchRate } })))),
    },
  };
  const sourceDeps = { sources, cache, cacheTtlMs: 60_000 };
  const compareDeps = {
    ...sourceDeps,
    db,
    stores: { model: models.store, channel: channels.store },
    fx: fxDeps,
  };
  const importDeps = {
    ...sourceDeps,
    db,
    stores: { provider: providers.store, channel: channels.store, model: models.store },
    cipher: fakeCipher,
    channelRpm: 60,
    channelBudget: '100',
    fx: fxDeps,
    audit: audit.sink,
  };
  return {
    db,
    providers,
    channels,
    models,
    audit,
    cache,
    compareDeps,
    importDeps,
    fxStore: fxStateStore,
  };
}

describe('目录源清单', () => {
  it('kind/channelName/needsKey 收敛回显', () => {
    const sources = [mockSource(), mockReferenceSource()];
    const infos = listCatalogSources(sources);
    expect(infos[0]).toMatchObject({
      id: 'mock-src',
      kind: 'channel',
      needsKey: true,
      channelName: 'mock-ch',
    });
    expect(infos[1]).toMatchObject({
      id: 'mock-ref',
      kind: 'reference',
      needsKey: false,
      channelName: null,
    });
  });
});

describe('comparison：三态 diff + 预填 + fx 快照 + channelReady + gone', () => {
  it('全载荷结构（prefill = 目录价 × effective；channelReady=false）', async () => {
    const { compareDeps } = setup([mockSource()]);
    const payload = await compareCatalogFromSource(compareDeps, 'mock-src');
    expect(payload).toMatchObject({
      source: 'mock-src',
      kind: 'channel',
      priceCurrency: 'USD',
      channelReady: false,
    });
    expect(payload.fx).toMatchObject({ mode: 'auto', baseRate: '7.2' });
    const gpt = defined(payload.items.find((i) => i.realModel === 'openai/gpt-4o'));
    expect(gpt.diff).toBe('new');
    expect(Number(gpt.prefillInputCny)).toBeCloseTo(2.5 * 7.2, 8);
    expect(payload.gone).toEqual([]);
  });

  it('已导入回填 + 消失检测（绑定到本源渠道但目录已无）', async () => {
    const s = setup([mockSource()]);
    // 预建渠道 + 已导入映射（真实模型在目录中）+ 一个目录已消失的绑定映射
    const chan = await s.channels.store.insertChannel(s.db, {
      providerId: 1,
      name: 'mock-ch',
      apiKeyEnc: 'x',
    });
    const kept = await s.models.store.insertMapping(s.db, {
      externalName: 'gpt-4o-alias',
      realModel: 'openai/gpt-4o',
      inputPrice: '18',
      outputPrice: '72',
      cacheInputPrice: '0',
      isFree: false,
    });
    const gone = await s.models.store.insertMapping(s.db, {
      externalName: 'legacy',
      realModel: 'legacy/old-model',
      inputPrice: '1',
      outputPrice: '1',
      cacheInputPrice: '0',
      isFree: false,
    });
    await s.models.store.ensureModelChannelBinding(s.db, {
      mappingId: kept.id,
      channelId: chan.id,
    });
    await s.models.store.ensureModelChannelBinding(s.db, {
      mappingId: gone.id,
      channelId: chan.id,
    });
    const payload = await compareCatalogFromSource(s.compareDeps, 'mock-src');
    expect(payload.channelReady).toBe(true);
    const gpt = defined(payload.items.find((i) => i.realModel === 'openai/gpt-4o'));
    expect(gpt.imported).toMatchObject({ externalName: 'gpt-4o-alias' });
    expect(gpt.diff).toBe('same');
    expect(payload.gone).toEqual([
      { mappingId: gone.id, externalName: 'legacy', realModel: 'legacy/old-model' },
    ]);
  });

  it('未知源 → catalog_source_not_found；源不可达 → catalog_source_unreachable（带源名与原因）', async () => {
    const { compareDeps } = setup([mockSource()]);
    await expect(compareCatalogFromSource(compareDeps, 'nope')).rejects.toMatchObject({
      code: 'control_plane.catalog_source_not_found',
    });
    const broken = setup([
      mockSource({
        fetchModels: async () => {
          throw new Error('connect timeout');
        },
      }),
    ]);
    await expect(compareCatalogFromSource(broken.compareDeps, 'mock-src')).rejects.toMatchObject({
      code: 'control_plane.catalog_source_unreachable',
      context: expect.objectContaining({ source: 'Mock 源', reason: 'connect timeout' }),
    });
  });

  it('源缓存 TTL：窗口内两次 comparison 只拉一次；过期后重拉', async () => {
    let fetches = 0;
    const counting = mockSource({
      fetchModels: async () => {
        fetches += 1;
        return RAW_CATALOG;
      },
    });
    const s = setup([counting]);
    await compareCatalogFromSource(s.compareDeps, 'mock-src');
    await compareCatalogFromSource(s.compareDeps, 'mock-src');
    expect(fetches).toBe(1);
    // 过期：直接缩短 TTL 重构依赖
    const expired = { ...s.compareDeps, cacheTtlMs: 0 };
    await compareCatalogFromSource(expired, 'mock-src');
    expect(fetches).toBe(2);
  });
});

describe('channel 导入（find-or-create + 单事务语义）', () => {
  it('首次导入：建 provider/渠道（密钥加密/护栏预填）+ 映射上架 + 绑定 + provenance 审计全链', async () => {
    const s = setup([mockSource()]);
    const result = await importCatalog(s.importDeps, {
      ctx: adminCtx(),
      sourceId: 'mock-src',
      apiKey: 'sk-platform',
      models: [
        {
          externalName: 'llama-3.3-70b',
          realModel: 'meta-llama/llama-3.3-70b-instruct:free',
          inputPrice: '0',
          outputPrice: '0',
          cacheInputPrice: '0',
          cacheWritePrice: '0',
        },
        {
          externalName: 'gpt-4o',
          realModel: 'openai/gpt-4o',
          inputPrice: '18',
          outputPrice: '72',
          cacheInputPrice: '9',
          cacheWritePrice: '0',
        },
      ],
    });
    expect(result).toMatchObject({ created: 2, updated: 0, skipped: 0 });
    expect(result.providerId).not.toBeNull();
    expect(result.channelId).not.toBeNull();
    const channel = defined([...s.channels.rows.values()][0]);
    expect(channel.name).toBe('mock-ch');
    expect(channel.rpmLimit).toBe(60);
    expect(channel.upstreamBudget).toBe('100');
    expect(fakeCipher.decrypt(channel.apiKeyEnc)).toBe('sk-platform');
    // isFree 按价格全零推导
    const llama = defined([...s.models.rows.values()].find((m) => m.realModel.includes('llama')));
    expect(llama.isFree).toBe(true);
    expect(llama.status).toBe(0);
    expect(llama.bindings.map((b) => b.channelId)).toEqual([channel.id]);
    // provenance 审计：fx 快照 + 目录价 + 预填 + 提交值
    const entry = defined(s.audit.entries.find((e) => e.action === 'model_catalog.import'));
    const detail = entry.detail as Record<string, unknown>;
    expect(detail.fx).toMatchObject({ baseRate: '7.2' });
    const audited = defined(
      (detail.models as Array<Record<string, unknown>>).find((m) => m.externalName === 'gpt-4o'),
    );
    expect(audited).toMatchObject({ catalogPrompt: '2.5', submittedInputCny: '18' });
    expect(Number(audited.prefillInputCny)).toBeCloseTo(2.5 * 7.2, 6);
  });

  it('首次导入缺平台 key → catalog_api_key_required；空模型清单 → catalog_empty', async () => {
    const s = setup([mockSource()]);
    await expect(
      importCatalog(s.importDeps, {
        ctx: adminCtx(),
        sourceId: 'mock-src',
        models: [
          {
            externalName: 'x',
            realModel: 'openai/gpt-4o',
            inputPrice: '1',
            outputPrice: '1',
            cacheInputPrice: '0',
            cacheWritePrice: '0',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'control_plane.catalog_api_key_required' });
    await expect(
      importCatalog(s.importDeps, { ctx: adminCtx(), sourceId: 'mock-src', models: [] }),
    ).rejects.toMatchObject({
      code: 'control_plane.catalog_empty',
    });
  });

  it('重复导入 = 价格更新确认（同一真实模型）；isFree 重推导；不覆盖已存渠道 key', async () => {
    const s = setup([mockSource()]);
    const first = await importCatalog(s.importDeps, {
      ctx: adminCtx(),
      sourceId: 'mock-src',
      apiKey: 'sk-first',
      models: [
        {
          externalName: 'gpt-4o',
          realModel: 'openai/gpt-4o',
          inputPrice: '18',
          outputPrice: '72',
          cacheInputPrice: '9',
          cacheWritePrice: '0',
        },
      ],
    });
    const second = await importCatalog(s.importDeps, {
      ctx: adminCtx(),
      sourceId: 'mock-src',
      models: [
        {
          externalName: 'gpt-4o',
          realModel: 'openai/gpt-4o',
          inputPrice: '20',
          outputPrice: '80',
          cacheInputPrice: '10',
          cacheWritePrice: '0',
          contextLength: 128_000,
        },
      ],
    });
    expect(second).toMatchObject({ channelId: first.channelId, created: 0, updated: 1 });
    const channel = defined(s.channels.rows.get(defined(first.channelId)));
    expect(fakeCipher.decrypt(channel.apiKeyEnc)).toBe('sk-first'); // 复用不覆盖
    const mapping = defined([...s.models.rows.values()].find((m) => m.externalName === 'gpt-4o'));
    expect(mapping.inputPrice).toBe('20');
    expect(mapping.contextLength).toBe(128_000);
    expect([...s.models.rows.values()]).toHaveLength(1);
  });

  it('外部名被其他真实模型占用 → external_name_conflict（整体回滚不留半成品）', async () => {
    const s = setup([mockSource()]);
    await importCatalog(s.importDeps, {
      ctx: adminCtx(),
      sourceId: 'mock-src',
      apiKey: 'sk',
      models: [
        {
          externalName: 'llama',
          realModel: 'meta-llama/llama-3.3-70b-instruct:free',
          inputPrice: '0',
          outputPrice: '0',
          cacheInputPrice: '0',
          cacheWritePrice: '0',
        },
      ],
    });
    await expect(
      importCatalog(s.importDeps, {
        ctx: adminCtx(),
        sourceId: 'mock-src',
        models: [
          {
            externalName: 'llama',
            realModel: 'openai/gpt-4o',
            inputPrice: '1',
            outputPrice: '1',
            cacheInputPrice: '0',
            cacheWritePrice: '0',
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'control_plane.external_name_conflict',
      context: expect.objectContaining({
        externalName: 'llama',
        boundTo: 'meta-llama/llama-3.3-70b-instruct:free',
      }),
    });
  });
});

describe('reference 导入（models.dev 草稿 + 对应渠道 find-or-create 绑定）', () => {
  it('草稿 status=1 + 按 provider 前缀建对应渠道（骨架占位 Key/基址）并绑定；同批同 provider 复用', async () => {
    const s = setup([mockReferenceSource()]);
    const result = await importCatalog(s.importDeps, {
      ctx: adminCtx(),
      sourceId: 'mock-ref',
      models: [
        {
          externalName: 'claude-sonnet-4',
          realModel: 'anthropic/claude-sonnet-4',
          inputPrice: '21.6',
          outputPrice: '108',
          cacheInputPrice: '2.16',
          cacheWritePrice: '0',
        },
        {
          externalName: 'gpt-4o',
          realModel: 'openai/gpt-4o',
          inputPrice: '18',
          outputPrice: '72',
          cacheInputPrice: '0',
          cacheWritePrice: '0',
        },
      ],
    });
    expect(result).toMatchObject({ created: 2, channelId: null, providerId: null });
    const claude = defined(
      [...s.models.rows.values()].find((m) => m.externalName === 'claude-sonnet-4'),
    );
    expect(claude.status).toBe(1); // 草稿
    // 两个 provider 各建一条对应渠道（provider 同名 find-or-create）
    expect([...s.channels.rows.values()].map((c) => c.name).toSorted()).toEqual([
      'anthropic',
      'openai',
    ]);
    const anthropicChannel = defined(
      [...s.channels.rows.values()].find((c) => c.name === 'anthropic'),
    );
    expect(anthropicChannel.rpmLimit).toBe(60);
    expect(anthropicChannel.upstreamBudget).toBe('100');
    expect(fakeCipher.decrypt(anthropicChannel.apiKeyEnc)).toBe('no-key-required'); // 占位 Key
    expect(claude.bindings.map((b) => b.channelId)).toEqual([anthropicChannel.id]);
    const provider = defined([...s.providers.rows.values()].find((p) => p.name === 'anthropic'));
    expect(provider.baseUrl).toBe('https://placeholder.invalid'); // 非路由占位基址
    expect(s.audit.entries.map((e) => e.action)).toContain('model_catalog.import_draft');
  });

  it('重复导入：改价跳过 + 绑定幂等；同 provider 第二个模型复用既有渠道不新建', async () => {
    const s = setup([mockReferenceSource()]);
    await importCatalog(s.importDeps, {
      ctx: adminCtx(),
      sourceId: 'mock-ref',
      models: [
        {
          externalName: 'claude-sonnet-4',
          realModel: 'anthropic/claude-sonnet-4',
          inputPrice: '21.6',
          outputPrice: '108',
          cacheInputPrice: '2.16',
          cacheWritePrice: '0',
        },
      ],
    });
    const second = await importCatalog(s.importDeps, {
      ctx: adminCtx(),
      sourceId: 'mock-ref',
      models: [
        {
          externalName: 'claude-sonnet-4',
          realModel: 'anthropic/claude-sonnet-4',
          inputPrice: '99',
          outputPrice: '99',
          cacheInputPrice: '0',
          cacheWritePrice: '0',
        },
        {
          externalName: 'claude-sonnet-4.5',
          realModel: 'anthropic/claude-sonnet-4.5',
          inputPrice: '30',
          outputPrice: '120',
          cacheInputPrice: '0',
          cacheWritePrice: '0',
        },
      ],
    });
    expect(second).toMatchObject({ created: 1, skipped: 1 });
    expect(defined([...s.models.rows.values()][0]).inputPrice).toBe('21.6'); // 已存在跳过不覆盖
    // 仍只有一条 anthropic 渠道；两个映射都绑在它上面
    const anthropicChannels = [...s.channels.rows.values()].filter((c) => c.name === 'anthropic');
    expect(anthropicChannels).toHaveLength(1);
    for (const mapping of s.models.rows.values()) {
      expect(mapping.bindings.map((b) => b.channelId)).toEqual([defined(anthropicChannels[0]).id]);
    }
  });

  it('存在同名对应渠道 → 复用不创建（真实 Key 不覆盖，也不建同名 provider）', async () => {
    const s = setup([mockReferenceSource()]);
    const real = await s.channels.store.insertChannel(s.db, {
      providerId: 1,
      name: 'anthropic',
      apiKeyEnc: fakeCipher.encrypt('sk-real-admin-key'),
    });
    const result = await importCatalog(s.importDeps, {
      ctx: adminCtx(),
      sourceId: 'mock-ref',
      models: [
        {
          externalName: 'claude-sonnet-4',
          realModel: 'anthropic/claude-sonnet-4',
          inputPrice: '21.6',
          outputPrice: '108',
          cacheInputPrice: '2.16',
          cacheWritePrice: '0',
        },
      ],
    });
    expect(result.created).toBe(1);
    expect(s.channels.rows.size).toBe(1); // 未新建渠道
    expect(fakeCipher.decrypt(defined(s.channels.rows.get(real.id)).apiKeyEnc)).toBe(
      'sk-real-admin-key',
    );
    expect([...s.providers.rows.values()].filter((p) => p.name === 'anthropic')).toHaveLength(0);
    const mapping = defined([...s.models.rows.values()][0]);
    expect(mapping.bindings.map((b) => b.channelId)).toEqual([real.id]);
  });

  it('无前缀 realModel → 整体作 slug；旧映射重导入幂等补绑对应渠道', async () => {
    const s = setup([mockReferenceSource()]);
    // 旧数据形态：映射已存在且无任何渠道绑定（本功能前的 reference 导入产物）
    const legacy = await s.models.store.insertMapping(s.db, {
      externalName: 'custom-model',
      realModel: 'custom-model',
      inputPrice: '5',
      outputPrice: '5',
      cacheInputPrice: '0',
      isFree: false,
      status: 1,
    });
    const result = await importCatalog(s.importDeps, {
      ctx: adminCtx(),
      sourceId: 'mock-ref',
      models: [
        {
          externalName: 'custom-model',
          realModel: 'custom-model',
          inputPrice: '50',
          outputPrice: '50',
          cacheInputPrice: '0',
          cacheWritePrice: '0',
        },
      ],
    });
    expect(result).toMatchObject({ created: 0, skipped: 1 });
    expect(defined(s.models.rows.get(legacy.id)).inputPrice).toBe('5'); // 价格不动
    const slugChannel = defined(
      [...s.channels.rows.values()].find((c) => c.name === 'custom-model'),
    );
    expect(slugChannel).toBeDefined();
    expect(defined(s.models.rows.get(legacy.id)).bindings.map((b) => b.channelId)).toEqual([
      slugChannel.id,
    ]);
  });
});

describe('价格溯源（provenance 读回）', () => {
  it('catalogPriceHistory 按对外名过滤 import 审计行', async () => {
    const s = setup([mockSource()]);
    await importCatalog(s.importDeps, {
      ctx: adminCtx(),
      sourceId: 'mock-src',
      apiKey: 'sk',
      models: [
        {
          externalName: 'gpt-4o',
          realModel: 'openai/gpt-4o',
          inputPrice: '18',
          outputPrice: '72',
          cacheInputPrice: '9',
          cacheWritePrice: '0',
        },
      ],
    });
    const history = await catalogPriceHistory(
      { db: s.db, stores: { audit: s.audit.store } },
      { externalName: 'gpt-4o' },
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: 'model_catalog.import',
      submittedInputCny: '18',
      submittedOutputCny: '72',
      fx: expect.objectContaining({ baseRate: '7.2' }),
    });
    expect(defined(history[0]).catalogPrompt).toBe('2.5');
  });
});

describe('分支补口：reference 源 comparison（无渠道护栏）与 fx 不可达导入', () => {
  it('reference 源 comparison：channelReady=false / channelRpmLimit=null / gone=[]', async () => {
    const s = setup([mockReferenceSource()]);
    const payload = await compareCatalogFromSource(s.compareDeps, 'mock-ref');
    expect(payload).toMatchObject({
      kind: 'reference',
      channelReady: false,
      channelRpmLimit: null,
      gone: [],
    });
    expect(payload.items[0]).toMatchObject({ realModel: 'anthropic/claude-sonnet-4', diff: 'new' });
  });

  it('fx 不可达时导入：prefill null（effectiveRate null）+ provenance fx=null 仍审计', async () => {
    const s = setup([mockSource()], 'fail');
    const result = await importCatalog(s.importDeps, {
      ctx: adminCtx(),
      sourceId: 'mock-src',
      apiKey: 'sk',
      models: [
        {
          externalName: 'gpt-4o-x',
          realModel: 'openai/gpt-4o',
          inputPrice: '20',
          outputPrice: '80',
          cacheInputPrice: '0',
          cacheWritePrice: '0',
        },
      ],
    });
    expect(result.created).toBe(1);
    const entry = defined(s.audit.entries.find((e) => e.action === 'model_catalog.import'));
    expect((entry.detail as { fx: unknown }).fx).toBeNull();
    const audited = defined(
      (entry.detail as { models: Array<{ prefillInputCny: string | null }> }).models[0],
    );
    expect(audited.prefillInputCny).toBeNull();
  });

  it('价格溯源空回（无匹配审计行 / detail 无 models 字段）', async () => {
    const s = setup([mockSource()]);
    const empty = await catalogPriceHistory(
      { db: s.db, stores: { audit: s.audit.store } },
      { externalName: 'nobody' },
    );
    expect(empty).toEqual([]);
    s.audit.entries.push({
      actor: 'admin',
      action: 'model_catalog.import',
      targetType: 'provider',
      targetId: '1',
      detail: null,
    });
    const stillEmpty = await catalogPriceHistory(
      { db: s.db, stores: { audit: s.audit.store } },
      { externalName: 'nobody' },
    );
    expect(stillEmpty).toEqual([]);
  });
});
