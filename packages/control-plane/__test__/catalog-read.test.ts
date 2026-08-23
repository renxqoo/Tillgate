/**
 * 网关热路径读契约（G1，gateway P5 波）：在架映射读（status 过滤 + fallback 列）、
 * 在架目录、用户费率卡上下文（三层系数）、路由候选行形状（启用过滤 + provider 富化）。
 * SQL 行为等价（join/排序/过滤下推）由 postgres.real.test.ts 承担；此处锁端口语义。
 */
import { describe, expect, it } from 'vitest';
import type { ProviderRecord } from '../src/ports/provider-store';
import {
  createMemoryDb,
  createMemoryChannelStore,
  createMemoryModelStore,
  createMemoryRateCardStore,
  type MemoryModelRow,
} from './memory';

const db = createMemoryDb();

const seedModel = (
  over: Partial<MemoryModelRow> & { id: number; externalName: string },
): MemoryModelRow => ({
  realModel: `real-${over.externalName}`,
  contextLength: null,
  status: 0,
  inputPrice: '1',
  outputPrice: '2',
  cacheInputPrice: '1',
  cacheWritePrice: '0',
  pricingUnit: 'token',
  unitPrice: '0',
  billingConfig: {},
  isFree: false,
  billingPolicy: null,
  rpmLimit: null,
  tpmLimit: null,
  deletedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  bindings: [],
  fallbackModels: null,
  pricingGroup: null,
  ...over,
});

describe('ModelStore 热路径读（G1）', () => {
  it('findActiveByExternalName：在架命中返回快照原料列；下架/未知返回 null', async () => {
    const { store } = createMemoryModelStore([
      seedModel({
        id: 1,
        externalName: 'gpt-x',
        fallbackModels: ['gpt-y'],
        pricingGroup: 'openai',
      }),
      seedModel({ id: 2, externalName: 'gone', status: 1 }),
    ]);
    const hit = await store.findActiveByExternalName(db, 'gpt-x');
    expect(hit).toMatchObject({
      id: 1,
      externalName: 'gpt-x',
      realModel: 'real-gpt-x',
      fallbackModels: ['gpt-y'],
      pricingGroup: 'openai',
      inputPrice: '1',
      pricingUnit: 'token',
    });
    expect(await store.findActiveByExternalName(db, 'gone')).toBeNull();
    expect(await store.findActiveByExternalName(db, 'nope')).toBeNull();
  });

  it('findActiveByExternalNames：批量含下架剔除、空入参空表', async () => {
    const { store } = createMemoryModelStore([
      seedModel({ id: 1, externalName: 'a' }),
      seedModel({ id: 2, externalName: 'b', status: 1 }),
      seedModel({ id: 3, externalName: 'c' }),
    ]);
    const map = await store.findActiveByExternalNames(db, ['a', 'b', 'c', 'zz']);
    expect([...map.keys()].toSorted()).toEqual(['a', 'c']);
    expect(await store.findActiveByExternalNames(db, [])).toEqual(new Map());
  });

  it('listEnabledMappings：仅在架、按外部名排序', async () => {
    const { store } = createMemoryModelStore([
      seedModel({ id: 2, externalName: 'zzz' }),
      seedModel({ id: 1, externalName: 'aaa' }),
      seedModel({ id: 3, externalName: 'off', status: 1 }),
    ]);
    const rows = await store.listEnabledMappings(db);
    expect(rows.map((r) => r.externalName)).toEqual(['aaa', 'zzz']);
    expect(rows[0]).toMatchObject({ realModel: 'real-aaa', pricingUnit: 'token' });
  });
});

describe('RateCardStore.findActiveCardByUser（G1）', () => {
  it('未绑卡 → null；绑卡返回卡面 + 三层系数行全集（含停用卡如实返回）', async () => {
    const h = createMemoryRateCardStore();
    // 建卡（insertWithGlobal 建 global 行）；补 model/group 覆写行并绑用户
    const card = await h.store.insertWithGlobal(db, {
      name: 'vip',
      description: null,
      coefficient: '0.8',
    });
    h.coefficients.push(
      {
        rateCardId: card.id,
        scope: 'model',
        modelMappingId: 7,
        groupKey: null,
        coefficient: '0.5',
      },
      {
        rateCardId: card.id,
        scope: 'group',
        modelMappingId: null,
        groupKey: 'openai',
        coefficient: '0.9',
      },
    );
    h.boundUsers.set(42, card.id);
    const ctx = await h.store.findActiveCardByUser(db, 42);
    expect(ctx).toMatchObject({ cardId: card.id, cardName: 'vip', status: 0 });
    expect(ctx!.coefficients.map((c) => c.scope).toSorted()).toEqual(['global', 'group', 'model']);
    expect(ctx!.coefficients.find((c) => c.scope === 'model')).toMatchObject({
      modelMappingId: 7,
      coefficient: '0.5',
    });
    expect(await h.store.findActiveCardByUser(db, 7)).toBeNull();
  });
});

describe('ChannelStore.findRouteCandidates（G1）', () => {
  it('仅启用渠道；provider 富化（协议/基址/厂商）；调度权重列齐全', async () => {
    const provider: ProviderRecord = {
      id: 1,
      name: 'upstream-a',
      protocol: 'openai-compatible',
      vendor: 'openai',
      baseUrl: 'https://a.example/v1',
      status: 0,
      deletedAt: null,
      createdAt: new Date(0),
    };
    const { store } = createMemoryChannelStore(
      (id) => (id === 1 ? 'upstream-a' : 'other'),
      [
        {
          id: 11,
          providerId: 1,
          name: 'ch-1',
          apiKeyEnc: 'enc:v1:x',
          baseUrlOverride: null,
          models: null,
          weight: 3,
          priority: 2,
          status: 0,
          failCount: 0,
          cooldownUntil: null,
          rpmLimit: 60,
          tpmLimit: 1000,
          upstreamBudget: '100',
          upstreamReserved: '0',
          upstreamThreshold: null,
          deletedAt: null,
        },
        {
          id: 12,
          providerId: 1,
          name: 'ch-disabled',
          apiKeyEnc: 'enc:v1:y',
          baseUrlOverride: 'https://ov.example',
          models: null,
          weight: 1,
          priority: 1,
          status: 1,
          failCount: 9,
          cooldownUntil: null,
          rpmLimit: null,
          tpmLimit: null,
          upstreamBudget: '0',
          upstreamReserved: '0',
          upstreamThreshold: null,
          deletedAt: null,
        },
      ],
      new Map(),
      new Map(),
      new Map([[1, provider]]),
    );
    const rows = await store.findRouteCandidates(db, 'real-any');
    // stand-in 局限：不按 realModel 过滤（postgres.real 承担过滤语义）——启用渠道全集
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channelId: 11,
      channelName: 'ch-1',
      apiKeyEnc: 'enc:v1:x',
      providerName: 'upstream-a',
      providerBaseUrl: 'https://a.example/v1',
      providerProtocol: 'openai-compatible',
      providerVendor: 'openai',
      priority: 2,
      weight: 3,
      rpmLimit: 60,
      tpmLimit: 1000,
      upstreamBudget: '100',
    });
  });
});
