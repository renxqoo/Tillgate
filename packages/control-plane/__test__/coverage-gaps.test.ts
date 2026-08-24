/**
 * 边界补口用例（§10.1.3：每条断言都有让 它失败的理由——补齐并发竞态路径、
 * 非管理员操作者、缺省装配构造、fx 环境分支与目录导入 provenance 分支）。
 */
import { describe, expect, it } from 'vitest';
import { createControlPlane } from '../src/control-plane';
import { createChannel } from '../src/application/channels/create-channel';
import { updateChannel } from '../src/application/channels/update-channel';
import { importChannels } from '../src/application/channels/import-channels';
import { probeChannel } from '../src/application/channels/probe-channel';
import { listChannels } from '../src/application/channels/list-channels';
import { createModel } from '../src/application/models/create-model';
import { adminIdOf, type ControlContext } from '../src/application/context';
import { setFxBuffer } from '../src/application/fx/set-fx-buffer';
import { doRefresh } from '../src/application/fx/fx-shared';
import type { FxDeps } from '../src/application/fx/fx-shared';
import { mapOpenAiCompatibleCatalog } from '../src/domain/catalog/catalog';
import type { CatalogSource } from '../src/ports/catalog-source';
import type { Db } from '@tillgate/db';
import { createMemoryCatalogCache } from '../src/ports/cache';
import {
  adminCtx,
  createMemoryChannelStore,
  createMemoryModelStore,
  createMemoryProviderStore,
  createMemoryAudit,
  createMemoryDb,
  createMemoryFxStore,
  createStubProbe,
  fakeCipher,
  uniqueViolation,
} from './memory';

const systemCtx: ControlContext = { requestId: 'sys-1', actor: { kind: 'system' } };

describe('操作者语义', () => {
  it('非管理员 actor → adminIdOf 返回 null（审计行 adminId 语义）', () => {
    expect(adminIdOf(adminCtx(5))).toBe(5);
    expect(adminIdOf(systemCtx)).toBeNull();
    expect(adminIdOf({ requestId: 'u', actor: { kind: 'user', id: 3 } })).toBeNull();
  });
});

describe('facade 缺省构造（audit/voucher/cache/store 不注入 → postgres/内存缺省）', () => {
  it('仅必填 env 即可装配（缺省件只在构造期创建，不触库）', () => {
    const controlPlane = createControlPlane({
      db: {} as Db,
      cipher: fakeCipher,
      capabilities: { protocols: ['openai-compatible'], vendorProfiles: [] },
      probe: createStubProbe().probe,
      defaultProtocol: 'openai-compatible',
      importMaxChannels: 10,
      sources: [],
      catalogTtlMs: 1000,
      catalogChannelRpm: 60,
      catalogChannelBudget: '0',
      voucherMaxBytes: 1024,
      fx: { sourceUrl: 'https://fx.example', autoTtlMs: 1000, fetchTimeoutMs: 1000 },
    });
    expect(Object.keys(controlPlane)).toHaveLength(9);
  });
});

describe('并发竞态路径（唯一索引兜底翻译）', () => {
  it('createModel：前置查重 miss 后撞唯一索引 → model_exists 兜底', async () => {
    const db = createMemoryDb();
    const models = createMemoryModelStore();
    // 竞态模拟：前置查重恒 miss，插入撞唯一索引
    const racing = {
      ...models.store,
      findByExternalName: async () => null,
    };
    await expect(
      createModel(
        { db, stores: { model: models.store }, audit: createMemoryAudit().sink },
        {
          ctx: adminCtx(),
          externalName: 'race',
          realModel: 'r',
          prices: { inputPrice: '1', outputPrice: '1', cacheInputPrice: '0' },
        },
      ),
    ).resolves.toBeTruthy();
    await expect(
      createModel(
        { db, stores: { model: racing }, audit: createMemoryAudit().sink },
        {
          ctx: adminCtx(),
          externalName: 'race',
          realModel: 'r',
          prices: { inputPrice: '1', outputPrice: '1', cacheInputPrice: '0' },
        },
      ),
    ).rejects.toMatchObject({ code: 'control_plane.model_exists' });
  });

  it('importChannels：同批同名第二条约 channel_exists；竞态撞索引走唯一冲突文案', async () => {
    const db = createMemoryDb();
    const providers = createMemoryProviderStore([
      {
        id: 1,
        name: 'prov',
        protocol: 'openai-compatible',
        vendor: null,
        baseUrl: 'https://x.example/v1',
        status: 0,
        deletedAt: null,
        createdAt: new Date(),
      },
    ]);
    const channels = createMemoryChannelStore(() => 'prov');
    const models = createMemoryModelStore();
    const deps = {
      db,
      stores: { channel: channels.store, provider: providers.store, model: models.store },
      cipher: fakeCipher,
      importMax: 10,
      audit: createMemoryAudit().sink,
    };
    const result = await importChannels(deps, {
      ctx: adminCtx(),
      channels: [
        { provider: 'prov', name: 'dup-in-batch', apiKey: 'k' },
        { provider: 'prov', name: 'dup-in-batch', apiKey: 'k' },
      ],
    });
    expect(result.details[1]!.error).toContain('already exists');
    // 竞态：查重 miss + 插入撞唯一索引 → 统一收口文案
    const racing = {
      ...deps,
      stores: {
        ...deps.stores,
        channel: {
          ...channels.store,
          findChannelByName: async () => null,
          insertChannel: async () => {
            throw uniqueViolation('channels_name_uq');
          },
        },
      },
    };
    const raced = await importChannels(racing, {
      ctx: adminCtx(),
      channels: [{ provider: 'prov', name: 'raced', apiKey: 'k' }],
    });
    expect(raced.details[0]!.error).toBe('Channel with the same name already exists');
    // 未知异常统一收口
    const crashing = {
      ...deps,
      stores: {
        ...deps.stores,
        channel: {
          ...channels.store,
          findChannelByName: async () => null,
          insertChannel: async () => {
            throw new Error('connection reset');
          },
        },
      },
    };
    const crashed = await importChannels(crashing, {
      ctx: adminCtx(),
      channels: [{ provider: 'prov', name: 'boom', apiKey: 'k' }],
    });
    expect(crashed.details[0]!.error).toBe('Import failed (data conflict or validation failure)');
  });
});

function channelFieldDeps() {
  const db = createMemoryDb();
  const providers = createMemoryProviderStore([
    {
      id: 1,
      name: 'prov',
      protocol: 'openai-compatible',
      vendor: null,
      baseUrl: 'https://p.example/v1',
      status: 0,
      deletedAt: null,
      createdAt: new Date(),
    },
  ]);
  return {
    db,
    providers,
    channels: createMemoryChannelStore(
      () => 'prov',
      undefined,
      new Map([[1, ['bound-a', 'bound-b']]]),
      new Map([[1, '12.5']]),
    ),
    audit: createMemoryAudit(),
  };
}

describe('渠道字段与探针分支', () => {
  it('创建带限流字段落库；更新带阈值与改名（审计 name 分支）', async () => {
    const base = channelFieldDeps();
    const deps = {
      db: base.db,
      stores: { channel: base.channels.store },
      cipher: fakeCipher,
      audit: base.audit.sink,
    };
    const { channels, audit } = base;
    const created = await createChannel(deps, {
      ctx: adminCtx(),
      providerId: 1,
      name: 'limited',
      apiKey: 'k',
      rpmLimit: 60,
      tpmLimit: 100_000,
    });
    expect(channels.rows.get(created.id)!.rpmLimit).toBe(60);
    expect(channels.rows.get(created.id)!.tpmLimit).toBe(100_000);
    await updateChannel(deps, {
      ctx: adminCtx(),
      channelId: created.id,
      patch: { name: 'renamed', upstreamThreshold: '5' },
    });
    expect(channels.rows.get(created.id)!.upstreamThreshold).toBe('5');
    expect(audit.entries.at(-1)!.detail).toMatchObject({ keyChanged: false, name: 'renamed' });
  });

  it('探针失败结果（上游 error 透传分支）；列表富化非空绑定与消耗', async () => {
    const base = channelFieldDeps();
    const deps = {
      db: base.db,
      stores: { channel: base.channels.store },
      cipher: fakeCipher,
      audit: base.audit.sink,
    };
    const created = await createChannel(deps, {
      ctx: adminCtx(),
      providerId: 1,
      name: 'probe-fail',
      apiKey: 'k',
    });
    const failing = createStubProbe({
      channel: () => ({
        ok: false,
        durationMs: 2,
        error: { code: 'upstream_429', message: 'slow down' },
      }),
    });
    const result = await probeChannel({ ...deps, probe: failing.probe }, created.id);
    expect(result).toMatchObject({ ok: false, error: { code: 'upstream_429' }, durationMs: 2 });
    // 非空富化：内存 store 注入了绑定与消耗
    const listed = await listChannels(deps, { sortBy: 'id', order: 'asc', limit: 10, offset: 0 });
    const enriched = listed.rows.find((r) => r.id === 1);
    expect(enriched!.boundModels).toEqual(['bound-a', 'bound-b']);
    expect(enriched!.upstreamConsumed).toBe('12.5');
  });
});

describe('fx 环境分支', () => {
  it('env.now 注入分支与非强制刷新新鲜早退（无 fetch 注入——不触网）', async () => {
    const db = createMemoryDb();
    const fx = createMemoryFxStore();
    const deps: FxDeps = {
      db,
      stores: { fx: fx.store },
      audit: createMemoryAudit().sink,
      env: {
        sourceUrl: 'https://fx.example',
        autoTtlMs: 60_000,
        fetchTimeoutMs: 1000,
        now: () => new Date('2026-08-23T00:00:00Z'),
      },
    };
    // 预置新鲜配置（fetchedAt = now）→ 非强制刷新早退（doFetch 缺省分支仅赋值不调用）
    await fx.store.upsertConfig(db, {
      value: { mode: 'auto', fetchedAt: '2026-08-23T00:00:00.000Z' },
      adminId: null,
    });
    await doRefresh(deps, false, null);
    expect(fx.rates).toHaveLength(0);
    await setFxBuffer(deps, { ctx: adminCtx(), bufferPct: '3' });
    expect((fx.config as { bufferPct: string }).bufferPct).toBe('3');
  });
});

describe('目录导入 provenance 分支', () => {
  it('提交真实模型不在目录货架（catalogItem null）→ provenance 置 null；reference 源 needsKey 短路', async () => {
    const db = createMemoryDb();
    const providers = createMemoryProviderStore();
    const channels = createMemoryChannelStore(() => 'prov');
    const models = createMemoryModelStore();
    const audit = createMemoryAudit();
    const fx = createMemoryFxStore();
    await fx.store.insertRate(db, { rate: '7.2', source: 'ecb', mode: 'auto' });
    await fx.store.upsertConfig(db, {
      value: { mode: 'auto', fetchedAt: new Date().toISOString() },
      adminId: null,
    });
    const source: CatalogSource = {
      id: 's',
      name: 'S',
      kind: 'channel',
      priceCurrency: 'CNY',
      channel: {
        providerName: 'sp',
        providerBaseUrl: 'https://sp.example/v1',
        providerProtocol: 'openai-compatible',
        channelName: 'sc',
        needsKey: false,
      },
      fetchModels: async () => ({ data: [{ id: 'known', pricing: { prompt: 1, completion: 2 } }] }),
      mapModels: (raw) => mapOpenAiCompatibleCatalog(raw, { currency: 'CNY' }),
    };
    const deps = {
      db,
      sources: [source],
      cache: createMemoryCatalogCache(),
      cacheTtlMs: 60_000,
      stores: { provider: providers.store, channel: channels.store, model: models.store },
      cipher: fakeCipher,
      channelRpm: 30,
      channelBudget: '50',
      fx: {
        db,
        stores: { fx: fx.store },
        audit: audit.sink,
        env: { sourceUrl: 'u', autoTtlMs: 1, fetchTimeoutMs: 1 },
      },
      audit: audit.sink,
    };
    const { importCatalog } = await import('../src/application/catalog/import-catalog');
    const result = await importCatalog(deps, {
      ctx: adminCtx(),
      sourceId: 's',
      models: [
        {
          externalName: 'unknown-alias',
          realModel: 'not-in-catalog',
          inputPrice: '1',
          outputPrice: '1',
          cacheInputPrice: '0',
          cacheWritePrice: '0',
        },
        {
          externalName: 'known-alias',
          realModel: 'known',
          inputPrice: '1',
          outputPrice: '2',
          cacheInputPrice: '0',
          cacheWritePrice: '0',
          contextLength: 8192,
        },
      ],
    });
    expect(result).toMatchObject({ created: 2 });
    const entry = audit.entries[0]!;
    const models2 = (
      entry.detail as {
        models: Array<{
          externalName: string;
          catalogPrompt: string | null;
          prefillInputCny: string | null;
        }>;
      }
    ).models;
    expect(models2[0]!.catalogPrompt).toBeNull();
    expect(models2[0]!.prefillInputCny).toBeNull();
    expect(models2[1]!.catalogPrompt).toBe('1000000'); // OpenRouter 口径恒每 token → ×1e6 归一
    // needsKey=false：未提供 apiKey 也建渠道（'no-key-required' 占位密文）
    const channel = [...channels.rows.values()][0]!;
    expect(fakeCipher.decrypt(channel.apiKeyEnc)).toBe('no-key-required');
  });
});
