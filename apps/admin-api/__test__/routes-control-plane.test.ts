import { describe, expect, it, vi } from 'vitest';
import { controlPlaneErrors } from '@tillgate/control-plane';
import { createAdminApp } from '../src/app';
import { AdminErrors } from '../src/http/error-face';
import { authHeader, fakeDeps } from './helpers';

/**
 * 控制面域契约（v1 providers/channels/channel-funds/models/rate-cards/fx/catalog
 * 测试行为规格子集）:CRUD 状态码 / 词表 4xx 命名空间码 / 列表白名单 / 幂等键透传。
 */

const providerRow = {
  id: 1,
  name: 'openai',
  protocol: 'openai-compatible',
  vendor: null,
  baseUrl: 'https://api.openai.com/v1',
  status: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const channelRow = {
  id: 2,
  name: 'ch',
  providerId: 1,
  providerName: 'openai',
  baseUrlOverride: null,
  models: ['gpt-x'],
  weight: 1,
  priority: 0,
  status: 0,
  failCount: 0,
  rpmLimit: null,
  tpmLimit: null,
  upstreamBudget: '100',
  upstreamThreshold: null,
  upstreamConsumed: '30',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  boundModels: ['gpt-x'],
};

const modelRow = {
  id: 3,
  externalName: 'gpt-x',
  realModel: 'gpt-real',
  contextLength: 128000,
  status: 0,
  inputPrice: '1',
  outputPrice: '2',
  cacheInputPrice: '0.1',
  cacheWritePrice: '0',
  pricingUnit: 'token',
  unitPrice: '0',
  billingConfig: {},
  isFree: false,
  billingPolicy: null,
  rpmLimit: null,
  tpmLimit: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function controlPlaneApp(overrides: Parameters<typeof fakeDeps>[0]['controlPlane']) {
  return createAdminApp(fakeDeps({ controlPlane: overrides }));
}

describe('providers', () => {
  it('列表/创建 201/更新/逻辑删除/恢复透传 ctx(admin actor)', async () => {
    const create = vi.fn(async () => providerRow);
    const remove = vi.fn(async () => ({ ok: true as const }));
    const undelete = vi.fn(async () => ({ ok: true as const }));
    const app = controlPlaneApp({
      providers: {
        list: async () => ({ rows: [providerRow], total: 1 }),
        create,
        update: async () => providerRow,
        delete: remove,
        undelete,
      },
    });
    const list = await app.request('/v1/providers?sort_by=name', { headers: authHeader() });
    expect(await list.json()).toMatchObject({ rows: [{ id: 1, vendor: null }], total: 1 });
    await app.request('/v1/providers?view=deleted', { headers: authHeader() });

    const created = await app.request('/v1/providers', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'openai', baseUrl: 'https://api.openai.com/v1' }),
    });
    expect(created.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ actor: { kind: 'admin', id: 7 } }),
      }),
    );

    const gone = await app.request('/v1/providers/1', { method: 'DELETE', headers: authHeader() });
    expect(await gone.json()).toEqual({ ok: true });
    expect(remove).toHaveBeenCalledWith({ ctx: expect.anything(), providerId: 1 });

    const back = await app.request('/v1/providers/1/restore', {
      method: 'POST',
      headers: authHeader(),
    });
    expect(await back.json()).toEqual({ ok: true });
    expect(undelete).toHaveBeenCalledWith({ ctx: expect.anything(), providerId: 1 });
  });

  it('协议词表外 → control_plane.invalid_protocol(4xx)', async () => {
    const app = controlPlaneApp({
      providers: {
        list: async () => ({ rows: [], total: 0 }),
        create: async () => {
          throw controlPlaneErrors.business('invalid_protocol', { protocol: 'bogus' });
        },
        update: async () => providerRow,
        delete: async () => ({ ok: true as const }),
        undelete: async () => ({ ok: true as const }),
      },
    });
    const res = await app.request('/v1/providers', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', baseUrl: 'https://x.test', protocol: 'bogus' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.json()).toMatchObject({ error: { code: 'control_plane.invalid_protocol' } });
  });
});

describe('channels + channel-funds', () => {
  it('列表富化(upstreamRemaining = budget − consumed);创建 201;import success=0 → 400', async () => {
    const importCall = vi.fn(async () => ({ success: 0, failed: 1, details: [] }));
    const app = controlPlaneApp({
      channels: {
        list: async () => ({ rows: [channelRow], total: 1 }),
        create: async () => ({ id: 9, name: 'ch', status: 0, failCount: 0 }),
        update: async () => ({ id: 9, name: 'ch', status: 0, failCount: 0 }),
        delete: async () => ({ ok: true as const }),
        undelete: async () => ({ ok: true as const }),
        import: importCall,
        probe: async () => ({ ok: true, durationMs: 5 }),
        recharge: async () => ({
          ok: true as const,
          rechargeId: 1,
          balanceAfter: '100',
          replayed: false,
        }),
        adjust: async () => ({
          ok: true as const,
          rechargeId: 2,
          balanceAfter: '90',
          replayed: false,
        }),
        listRecharges: async () => ({ rows: [], total: 0 }),
      },
    });
    const list = await app.request('/v1/channels', { headers: authHeader() });
    const body = (await list.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows[0]).toMatchObject({
      upstreamRemaining: '70',
      boundModels: ['gpt-x'],
      cooldownUntil: null,
      providerBaseUrl: null,
      updatedAt: null,
    });

    const created = await app.request('/v1/channels', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 1, name: 'ch', apiKey: 'sk-1', models: ['gpt-x'] }),
    });
    expect(created.status).toBe(201);

    const failed = await app.request('/v1/channels/import', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ channels: [{ provider: 'p', name: 'c', apiKey: 'k' }] }),
    });
    expect(failed.status).toBe(400);

    const probe = await app.request('/v1/channels/2/test', {
      method: 'POST',
      headers: authHeader(),
    });
    expect(await probe.json()).toMatchObject({ ok: true });
  });

  it('进货:凭证内联透传 + 幂等键透传(idempotency-key 头)', async () => {
    const recharge = vi.fn(async () => ({
      ok: true as const,
      rechargeId: 1,
      balanceAfter: '100',
      replayed: false,
    }));
    const app = controlPlaneApp({
      channels: {
        list: async () => ({ rows: [], total: 0 }),
        create: async () => ({ id: 1, name: 'c', status: 0, failCount: 0 }),
        update: async () => ({ id: 1, name: 'c', status: 0, failCount: 0 }),
        delete: async () => ({ ok: true as const }),
        undelete: async () => ({ ok: true as const }),
        import: async () => ({ success: 1, failed: 0, details: [] }),
        probe: async () => ({ ok: true, durationMs: 1 }),
        recharge,
        adjust: async () => ({
          ok: true as const,
          rechargeId: 1,
          balanceAfter: '1',
          replayed: false,
        }),
        listRecharges: async () => ({ rows: [], total: 0 }),
      },
    });
    await app.request('/v1/channel-funds/recharge', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json', 'idempotency-key': 'rc-1' },
      body: JSON.stringify({
        channelId: 2,
        amount: '100',
        voucherDataUrl: 'data:text/plain;base64,QQ==',
      }),
    });
    expect(recharge).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 2,
        amount: '100',
        voucherDataUrl: 'data:text/plain;base64,QQ==',
        operationId: 'rc-1',
      }),
    );
  });
});

describe('models + rate-cards + fx + catalog', () => {
  it('models:创建价格组缺省(cacheWritePrice/unitPrice=0);绑定 500 上限;探针', async () => {
    const create = vi.fn(async () => modelRow);
    const bind = vi.fn(async () => ({ bound: 1 }));
    const app = controlPlaneApp({
      models: {
        list: async () => ({ rows: [{ ...modelRow, channelIds: [2] }], total: 1 }),
        create,
        update: async () => modelRow,
        delete: async () => ({ ok: true as const }),
        undelete: async () => ({ ok: true as const }),
        bindChannels: bind,
        probe: async () => ({ ok: true, durationMs: 3, tokens: 5 }),
      },
    });
    const created = await app.request('/v1/models', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({
        externalName: 'gpt-x',
        realModel: 'gpt-real',
        inputPrice: '1',
        outputPrice: '2',
        cacheInputPrice: '0.1',
      }),
    });
    expect(created.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        prices: {
          inputPrice: '1',
          outputPrice: '2',
          cacheInputPrice: '0.1',
          cacheWritePrice: '0',
          unitPrice: '0',
        },
        pricingUnit: 'token',
      }),
    );

    // unitPrice 数字形态:coerce 分支 → transform String;超 1e12 拒 400
    const numeric = await app.request('/v1/models', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({
        externalName: 'gpt-y',
        realModel: 'gpt-real',
        inputPrice: '1',
        outputPrice: '2',
        cacheInputPrice: '0.1',
        unitPrice: 0.5,
      }),
    });
    expect(numeric.status).toBe(201);
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ prices: expect.objectContaining({ unitPrice: '0.5' }) }),
    );
    const overflow = await app.request('/v1/models', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({
        externalName: 'gpt-z',
        realModel: 'gpt-real',
        inputPrice: '1',
        outputPrice: '2',
        cacheInputPrice: '0.1',
        unitPrice: 2e12,
      }),
    });
    expect(overflow.status).toBe(400);

    const list = await app.request('/v1/models', { headers: authHeader() });
    expect(await list.json()).toMatchObject({ rows: [{ channelIds: [2], fallbackModels: null }] });

    const bound = await app.request('/v1/models/3/channels', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ channels: [{ channelId: 2 }] }),
    });
    expect(await bound.json()).toEqual({ ok: true, bound: 1 });
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ mappingId: 3 }));
  });

  it('rate-cards:系数词表 400;卡内用户/健康', async () => {
    const app = controlPlaneApp({
      rates: {
        listCards: async () => ({
          rows: [
            {
              id: 1,
              name: '标准',
              description: null,
              status: 0,
              createdAt: new Date('2026-01-01T00:00:00Z'),
              updatedAt: new Date('2026-01-02T00:00:00Z'),
              coefficient: '1.000',
            },
          ],
          total: 1,
        }),
        createCard: async () => ({ id: 1, name: '标准', coefficient: '1.000' }),
        updateCard: async () => ({ id: 1, name: '标准' }),
        deleteCard: async () => ({ ok: true as const }),
        listCardUsers: async () => ({ rows: [], total: 0 }),
        cardHealth: async () => ({ hasGlobalCoefficient: true, coefficient: '1.000' }),
      },
    });
    const bad = await app.request('/v1/rate-cards', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', coefficient: '12.5' }),
    });
    expect(bad.status).toBe(400);
    const list = await app.request('/v1/rate-cards', { headers: authHeader() });
    expect(await list.json()).toMatchObject({
      rows: [{ coefficient: '1.000', updatedAt: '2026-01-02T00:00:00.000Z' }],
    });
    const health = await app.request('/v1/rate-cards/1/health', { headers: authHeader() });
    expect(await health.json()).toEqual({ hasGlobalCoefficient: true, coefficient: '1.000' });
  });

  it('fx:state/refresh/override(PUT+DELETE)/buffer', async () => {
    const fx = {
      state: async () => ({ mode: 'auto' }),
      refresh: vi.fn(async () => ({ mode: 'auto' })),
      setOverride: vi.fn(async () => ({ mode: 'override' })),
      clearOverride: vi.fn(async () => ({ mode: 'auto' })),
      setBuffer: vi.fn(async () => ({ mode: 'auto' })),
    };
    const app = controlPlaneApp({ fx });
    expect(await (await app.request('/v1/fx/catalog', { headers: authHeader() })).json()).toEqual({
      mode: 'auto',
    });
    await app.request('/v1/fx/catalog/refresh', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(fx.refresh).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, ctx: expect.anything() }),
    );
    await app.request('/v1/fx/catalog/override', {
      method: 'PUT',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ rate: '7.2' }),
    });
    expect(fx.setOverride).toHaveBeenCalledWith(expect.objectContaining({ rate: '7.2' }));
    await app.request('/v1/fx/catalog/override', { method: 'DELETE', headers: authHeader() });
    expect(fx.clearOverride).toHaveBeenCalled();
  });

  it('settings:billing-timezone 读 + 写（ctx 透传）+ 空时区 400', async () => {
    const billingTimezone = {
      read: async () => ({ timezone: 'Asia/Shanghai' }),
      update: vi.fn(async () => ({ timezone: 'UTC' })),
    };
    const app = controlPlaneApp({ settings: { billingTimezone } });
    const read = await app.request('/v1/settings/billing-timezone', { headers: authHeader() });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ timezone: 'Asia/Shanghai' });
    const put = await app.request('/v1/settings/billing-timezone', {
      method: 'PUT',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: 'UTC' }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ timezone: 'UTC' });
    expect(billingTimezone.update).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: 'UTC', ctx: expect.anything() }),
    );
    const bad = await app.request('/v1/settings/billing-timezone', {
      method: 'PUT',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: '' }),
    });
    expect(bad.status).toBe(400);
  });

  it('settings:integrations 列表/更新（ctx 透传）+ 未知 key 404 + 形状 400', async () => {
    const integrations = {
      list: async () => ({
        integrations: [
          {
            key: 'smtp',
            enabled: true,
            configured: true,
            config: { host: 'smtp.example.com', pass: '****s-9' },
            secretsSet: ['pass'],
            rotatedAt: null,
            updatedAt: '2026-08-25T00:00:00.000Z',
            updatedByAdminId: 7,
          },
        ],
      }),
      update: vi.fn(async () => ({
        key: 'smtp',
        enabled: false,
        configured: true,
        config: {},
        secretsSet: [],
        rotatedAt: null,
        updatedAt: '2026-08-25T00:00:00.000Z',
        updatedByAdminId: 7,
      })),
    };
    const app = controlPlaneApp({
      settings: {
        billingTimezone: {
          read: async () => ({ timezone: null }),
          update: async () => ({ timezone: 'UTC' }),
        },
        integrations,
      },
    });
    const list = await app.request('/v1/settings/integrations', { headers: authHeader() });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { integrations: Array<{ key: string }> };
    expect(listed.integrations[0]?.key).toBe('smtp');

    const put = await app.request('/v1/settings/integrations/smtp', {
      method: 'PUT',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ totpCode: '123456', enabled: false, config: { host: 'smtp2.example.com' } }),
    });
    expect(put.status).toBe(200);
    expect(integrations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'smtp',
        enabled: false,
        config: { host: 'smtp2.example.com' },
        ctx: expect.anything(),
      }),
    );

    // 契约层只拦形状：空串字段值 400（语义校验在 control-plane 用例）
    const badShape = await app.request('/v1/settings/integrations/smtp', {
      method: 'PUT',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ config: { host: '' } }),
    });
    expect(badShape.status).toBe(400);
  });

  it('settings:integrations 未知 key 映射 404（integration_unknown）', async () => {
    const integrations = {
      list: async () => ({ integrations: [] }),
      update: vi.fn(async () => {
        throw controlPlaneErrors.business('integration_unknown', { key: 'payment.paypal' });
      }),
    };
    const app = controlPlaneApp({
      settings: {
        billingTimezone: {
          read: async () => ({ timezone: null }),
          update: async () => ({ timezone: 'UTC' }),
        },
        integrations,
      },
    });
    const res = await app.request('/v1/settings/integrations/payment.paypal', {
      method: 'PUT',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ totpCode: '123456', enabled: true }),
    });
    expect(res.status).toBe(404);
  });

  it('catalog:源清单/价格溯源 externalName 必填/未知源 404', async () => {
    const app = controlPlaneApp({
      catalog: {
        listSources: () => [{ id: 'models-dev', name: 'models.dev' }] as never,
        comparison: async (sourceId: string) => {
          if (sourceId === 'nope') {
            throw AdminErrors.business('catalog_source_not_found', { sourceId });
          }
          return { items: [] } as never;
        },
        priceHistory: async () => [] as never,
        import: async () => ({ created: 0 }) as never,
      },
    });
    const sources = await app.request('/v1/model-catalog/sources', { headers: authHeader() });
    expect(await sources.json()).toMatchObject({ sources: [{ id: 'models-dev' }] });
    // P6/D1:词表端点 = 装配注入面原样透传(fakeDeps 默认词表;真源封闭性锁在 ai 包)
    const words = await app.request('/v1/vendor-catalog', { headers: authHeader() });
    expect(words.status).toBe(200);
    expect(await words.json()).toEqual({
      protocols: ['openai-compatible'],
      vendors: ['openai'],
    });
    const missing = await app.request('/v1/model-catalog/price-history', { headers: authHeader() });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: 'admin.invalid_param' } });
    const unknown = await app.request('/v1/model-catalog/nope', { headers: authHeader() });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      error: { code: 'admin.catalog_source_not_found' },
    });
  });
});
