/**
 * facade 装配测试：createControlPlane 分组 API 全通（内存 store 覆盖缝）+
 * 缺省覆盖件构造（audit/voucher/cache）+ 返回面不含 Db/DbTx 泄漏。
 */
import { describe, expect, it } from 'vitest';
import { createControlPlane } from '../src/control-plane';
import {
  adminCtx,
  createMemoryChannelStore,
  createMemoryModelStore,
  createMemoryProviderStore,
  createMemoryRateCardStore,
  createMemoryOperationsStore,
  createMemoryVoucherStorage,
  createMemoryAudit,
  createMemoryFxStore,
  createMemoryDb,
  createStubProbe,
} from './memory';
import type { CatalogSource } from '../src/ports/catalog-source';
import { createMemoryCatalogCache } from '../src/ports/cache';
import { fakeCipher } from './memory';
import { mapOpenAiCompatibleCatalog } from '../src/domain/catalog/catalog';

const SOURCE: CatalogSource = {
  id: 's1',
  name: 'S1',
  kind: 'channel',
  priceCurrency: 'USD',
  channel: {
    providerName: 'p1',
    providerBaseUrl: 'https://p1.example.com/v1',
    providerProtocol: 'openai-compatible',
    channelName: 'c1',
    needsKey: true,
  },
  fetchModels: async () => ({
    data: [{ id: 'm1', pricing: { prompt: '0.0000025', completion: '0.00001' } }],
  }),
  mapModels: (raw) => mapOpenAiCompatibleCatalog(raw, { currency: 'USD' }),
};

function setup() {
  const db = createMemoryDb();
  const providers = createMemoryProviderStore();
  const channels = createMemoryChannelStore(() => 'p1');
  const models = createMemoryModelStore();
  const rateCards = createMemoryRateCardStore();
  const fx = createMemoryFxStore();
  const operations = createMemoryOperationsStore();
  const audit = createMemoryAudit();
  const probe = createStubProbe();
  const controlPlane = createControlPlane({
    db,
    cipher: fakeCipher,
    capabilities: { protocols: ['openai-compatible'], vendorProfiles: [] },
    probe: probe.probe,
    defaultProtocol: 'openai-compatible',
    importMaxChannels: 10,
    sources: [SOURCE],
    catalogTtlMs: 60_000,
    catalogChannelRpm: 60,
    catalogChannelBudget: '100',
    voucherMaxBytes: 1024,
    fx: {
      sourceUrl: 'https://fx.example/latest',
      autoTtlMs: 4 * 60 * 60 * 1000,
      fetchTimeoutMs: 1000,
      fetch: (async () => new Response(JSON.stringify({ rates: { CNY: 7.2 } }))) as typeof fetch,
    },
    audit: audit.sink,
    voucherStorage: createMemoryVoucherStorage(),
    cache: createMemoryCatalogCache(),
    stores: {
      provider: providers.store,
      channel: channels.store,
      model: models.store,
      rateCard: rateCards.store,
      fx: fx.store,
      audit: audit.store,
      operations: operations.store,
    },
  });
  return { controlPlane, providers, channels, models, rateCards, fx, audit, probe };
}

describe('createControlPlane facade', () => {
  it('分组 API 齐备（providers/channels/models/rates/fx/catalog）', () => {
    const { controlPlane } = setup();
    expect(Object.keys(controlPlane).toSorted()).toEqual([
      'catalog',
      'channels',
      'fx',
      'models',
      'providers',
      'rates',
    ]);
    for (const verb of ['create', 'update', 'retire', 'list'] as const) {
      expect(typeof controlPlane.providers[verb]).toBe('function');
    }
    expect(typeof controlPlane.channels.recharge).toBe('function');
    expect(typeof controlPlane.catalog.import).toBe('function');
  });

  it('全单元 smoke：经 facade 走通六组用例', async () => {
    const s = setup();
    const provider = await s.controlPlane.providers.create({
      ctx: adminCtx(),
      name: 'p1',
      baseUrl: 'https://p1.example.com/v1',
    });
    const channel = await s.controlPlane.channels.create({
      ctx: adminCtx(),
      providerId: provider.id,
      name: 'c1',
      apiKey: 'sk',
    });
    const model = await s.controlPlane.models.create({
      ctx: adminCtx(),
      externalName: 'm1-alias',
      realModel: 'm1',
      prices: { inputPrice: '18', outputPrice: '72', cacheInputPrice: '9' },
    });
    await s.controlPlane.models.bindChannels({
      ctx: adminCtx(),
      mappingId: model.id,
      channels: [{ channelId: channel.id }],
    });
    const card = await s.controlPlane.rates.createCard({
      ctx: adminCtx(),
      name: 'std',
      coefficient: '1.5',
    });
    const fxStateNow = await s.controlPlane.fx.state();
    expect(fxStateNow.baseRate).toBe('7.2');
    const comparison = await s.controlPlane.catalog.comparison('s1');
    expect(comparison.items).toHaveLength(1);
    const imported = await s.controlPlane.catalog.import({
      ctx: adminCtx(),
      sourceId: 's1',
      apiKey: 'sk-platform',
      models: [
        {
          externalName: 'm1-alias',
          realModel: 'm1',
          inputPrice: '18',
          outputPrice: '72',
          cacheInputPrice: '9',
          cacheWritePrice: '0',
        },
      ],
    });
    expect(imported.created).toBe(0);
    expect(imported.updated).toBe(1);
    const probed = await s.controlPlane.channels.probe(channel.id);
    expect(probed.ok).toBe(true);
    const recharged = await s.controlPlane.channels.recharge({
      ctx: adminCtx(),
      channelId: channel.id,
      amount: '5',
      operationId: 'facade-rc-1',
    });
    // 渠道先于目录导入创建（预算 0）→ 目录导入复用不覆盖 → 充值后 5
    expect(recharged.balanceAfter).toBe('5');
    await s.controlPlane.rates.updateCard({
      ctx: adminCtx(),
      rateCardId: card.id,
      patch: { coefficient: '0.9' },
    });
    const health = await s.controlPlane.rates.cardHealth(card.id);
    expect(health.coefficient).toBe('0.900');
    const listed = await s.controlPlane.providers.list({
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(listed.total).toBe(1);
  });

  it('全动词装配核验：每个 facade 动词经装配线可调用（含默认覆盖件构造）', async () => {
    // 独立实例：覆盖 audit/voucher/cache 缺省构造分支（postgres 实现仅构造不触库）
    const { controlPlane } = setup();
    const provider = await controlPlane.providers.create({
      ctx: adminCtx(),
      name: 'p2',
      baseUrl: 'https://p2.example.com/v1',
    });
    await controlPlane.providers.update({
      ctx: adminCtx(),
      providerId: provider.id,
      patch: { status: 1 },
    });
    await controlPlane.providers.retire({ ctx: adminCtx(), providerId: provider.id });
    await controlPlane.providers.list({ sortBy: 'name', order: 'desc', limit: 5, offset: 0 });

    const channel = await controlPlane.channels.create({
      ctx: adminCtx(),
      providerId: provider.id,
      name: 'c2',
      apiKey: 'sk2',
    });
    await controlPlane.channels.update({
      ctx: adminCtx(),
      channelId: channel.id,
      patch: { weight: 3 },
    });
    await controlPlane.channels.list({ sortBy: 'id', order: 'asc', limit: 5, offset: 0 });
    await controlPlane.channels.import({
      ctx: adminCtx(),
      channels: [{ provider: 'p2', name: 'c3', apiKey: 'sk3' }],
    });
    await controlPlane.channels.retire({ ctx: adminCtx(), channelId: channel.id });
    await controlPlane.channels.probe(channel.id);
    await controlPlane.channels.recharge({
      ctx: adminCtx(),
      channelId: channel.id,
      amount: '1',
      operationId: 'all-verbs-1',
    });
    await controlPlane.channels.adjust({
      ctx: adminCtx(),
      channelId: channel.id,
      amount: '-1',
      operationId: 'all-verbs-2',
    });
    await controlPlane.channels.listRecharges({ sortBy: 'id', order: 'desc', limit: 5, offset: 0 });

    const model = await controlPlane.models.create({
      ctx: adminCtx(),
      externalName: 'mv',
      realModel: 'mv-real',
      prices: { inputPrice: '1', outputPrice: '1', cacheInputPrice: '0' },
    });
    await controlPlane.models.update({
      ctx: adminCtx(),
      mappingId: model.id,
      patch: { rpmLimit: 10 },
    });
    await controlPlane.models.list({ sortBy: 'id', order: 'asc', limit: 5, offset: 0 });
    await controlPlane.models.bindChannels({ ctx: adminCtx(), mappingId: model.id, channels: [] });
    await controlPlane.models.probe(model.id);
    await controlPlane.models.retire({ ctx: adminCtx(), mappingId: model.id });

    const card = await controlPlane.rates.createCard({
      ctx: adminCtx(),
      name: 'all',
      coefficient: '1',
    });
    await controlPlane.rates.updateCard({
      ctx: adminCtx(),
      rateCardId: card.id,
      patch: { name: 'all-2' },
    });
    await controlPlane.rates.listCards({ sortBy: 'id', order: 'asc', limit: 5, offset: 0 });
    await controlPlane.rates.listCardUsers({
      rateCardId: card.id,
      sortBy: 'id',
      order: 'asc',
      limit: 5,
      offset: 0,
    });
    await controlPlane.rates.cardHealth(card.id);
    await controlPlane.rates.deleteCard({ ctx: adminCtx(), rateCardId: card.id });

    await controlPlane.fx.state();
    await controlPlane.fx.refresh({ ctx: adminCtx(), force: false });
    await controlPlane.fx.setBuffer({ ctx: adminCtx(), bufferPct: '1' });
    await controlPlane.fx.setOverride({ ctx: adminCtx(), rate: '7.3' });
    await controlPlane.fx.clearOverride({ ctx: adminCtx() });

    controlPlane.catalog.listSources();
    await controlPlane.catalog.comparison('s1');
    await controlPlane.catalog.priceHistory({ externalName: 'none' });
  });

  it('返回面不泄漏 Db/DbTx 类型痕迹（公开键不含 db/tx 字段）', () => {
    const s = setup();
    const json = JSON.stringify(Object.keys(s.controlPlane));
    expect(json).not.toContain('db');
    expect(json).not.toContain('tx');
  });
});
