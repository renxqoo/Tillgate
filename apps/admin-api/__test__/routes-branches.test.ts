import { describe, expect, it } from 'vitest';
import { createAdminApp } from '../src/app';
import { authHeader, fakeDeps } from './helpers';

/**
 * 分支清扫：补齐契约测试未走的动词/过滤/缺省分支（覆盖率 90/85 门槛的补面——
 * 断言语义与 routes-* 主测试同源,不引入新行为规格）。
 */

const json = { ...authHeader(), 'content-type': 'application/json' };

const providerRow = {
  id: 1,
  name: 'openai',
  protocol: 'openai-compatible',
  vendor: null,
  baseUrl: 'https://api.openai.com/v1',
  status: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('providers/channels 补面', () => {
  it('PATCH 更新与 DELETE 退役;列表 q 透传', async () => {
    const update = async () => ({ ...providerRow, status: 1 });
    const app = createAdminApp(
      fakeDeps({
        controlPlane: {
          providers: {
            list: async () => ({ rows: [], total: 0 }),
            create: async () => providerRow,
            update,
            retire: async () => ({ ok: true as const }),
          },
          channels: {
            list: async () => ({ rows: [], total: 0 }),
            create: async () => ({ id: 1, name: 'c', status: 0, failCount: 0, providerId: 1 }),
            update: async () => ({ id: 1, name: 'c', status: 0, failCount: 0, providerId: 1 }),
            retire: async () => ({ ok: true as const }),
            import: async () => ({ success: 2, failed: 0, total: 2, details: [] }),
            probe: async () => ({ ok: false, durationMs: 1, error: { code: 'x', message: 'y' } }),
            recharge: async () => ({
              ok: true as const,
              rechargeId: 1,
              balanceAfter: '1',
              replayed: false,
            }),
            adjust: async () => ({
              ok: true as const,
              rechargeId: 1,
              balanceAfter: '1',
              replayed: false,
            }),
            listRecharges: async () => ({ rows: [], total: 0 }),
          },
        },
      }),
    );
    const patched = await app.request('/v1/providers/1', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ vendor: null, status: 1 }),
    });
    expect(await patched.json()).toMatchObject({ id: 1, vendor: null, status: 1 });
    expect(
      (await app.request('/v1/providers/1', { method: 'DELETE', headers: authHeader() })).status,
    ).toBe(200);
    await app.request('/v1/providers?q=openai', { headers: authHeader() });

    const chPatched = await app.request('/v1/channels/1', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ name: 'c2', upstreamThreshold: null, rpmLimit: null, models: null }),
    });
    expect(chPatched.status).toBe(200);
    expect(
      (await app.request('/v1/channels/1', { method: 'DELETE', headers: authHeader() })).status,
    ).toBe(200);
    const imported = await app.request('/v1/channels/import', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        channels: [
          { provider: 'p', name: 'a', apiKey: 'k', weight: 2, priority: 1, models: ['m'] },
        ],
      }),
    });
    expect(imported.status).toBe(200);
    const probeFailed = await app.request('/v1/channels/1/test', {
      method: 'POST',
      headers: authHeader(),
    });
    expect(await probeFailed.json()).toMatchObject({ ok: false, error: { code: 'x' } });
    await app.request('/v1/channels?q=x', { headers: authHeader() });
  });
});

describe('channel-funds 补面', () => {
  it('流水列表(channelId/type/q 过滤)与调账动词', async () => {
    const app = createAdminApp(
      fakeDeps({
        controlPlane: {
          channels: {
            list: async () => ({ rows: [], total: 0 }),
            create: async () => ({ id: 1, name: 'c', status: 0, failCount: 0, providerId: 1 }),
            update: async () => ({ id: 1, name: 'c', status: 0, failCount: 0, providerId: 1 }),
            retire: async () => ({ ok: true as const }),
            import: async () => ({ success: 1, failed: 0, total: 1, details: [] }),
            probe: async () => ({ ok: true, durationMs: 1 }),
            recharge: async () => ({
              ok: true as const,
              rechargeId: 1,
              balanceAfter: '1',
              replayed: false,
            }),
            adjust: async () => ({
              ok: true as const,
              rechargeId: 2,
              balanceAfter: '9',
              replayed: false,
            }),
            listRecharges: async () => ({
              rows: [
                {
                  id: 1,
                  channelId: 2,
                  channelName: 'c',
                  type: 'adjust',
                  amount: '-1',
                  balanceAfter: '9',
                  orderNo: null,
                  voucher: null,
                  remark: null,
                  adminId: 7,
                  adminEmail: 'a@t.dev',
                  adminDisplayName: 'A',
                  createdAt: new Date('2026-08-01T00:00:00Z'),
                },
              ],
              total: 1,
            }),
          },
        },
      }),
    );
    const list = await app.request('/v1/channel-funds?channelId=2&type=adjust&q=x&sort_by=amount', {
      headers: authHeader(),
    });
    expect(await list.json()).toMatchObject({
      rows: [{ id: 1, type: 'adjust', amount: '-1', adminEmail: 'a@t.dev' }],
      total: 1,
    });
    const adjusted = await app.request('/v1/channel-funds/adjust', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ channelId: 2, amount: '-1', remark: 'r' }),
    });
    expect(await adjusted.json()).toMatchObject({ rechargeId: 2, balanceAfter: '9' });
  });
});

describe('models/rate-cards 补面', () => {
  const modelRow = {
    id: 3,
    externalName: 'gpt-x',
    realModel: 'gpt-real',
    contextLength: null,
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
  const cardRow = {
    id: 1,
    name: '标准',
    description: null,
    status: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    coefficient: '1.000',
  };

  it('models:PATCH 全价组/单位计价 number 收窄/DELETE/探针', async () => {
    const app = createAdminApp(
      fakeDeps({
        controlPlane: {
          models: {
            list: async () => ({ rows: [], total: 0 }),
            create: async () => modelRow,
            update: async () => modelRow,
            retire: async () => ({ ok: true as const }),
            bindChannels: async () => ({ bound: 0 }),
            probe: async () => ({ ok: true, durationMs: 2, results: [] }),
          },
        },
      }),
    );
    const created = await app.request('/v1/models', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        externalName: 'img',
        realModel: 'img-real',
        inputPrice: '0',
        outputPrice: '0',
        cacheInputPrice: '0',
        unitPrice: 0.5,
        pricingUnit: 'image',
        billingConfig: {
          strategy: 'variant',
          params: { selector: 'size', prices: { '1024x1024': '1' } },
        },
        isFree: true,
        billingPolicy: null,
        rpmLimit: null,
        tpmLimit: null,
        contextLength: null,
      }),
    });
    expect(created.status).toBe(201);
    const patched = await app.request('/v1/models/3', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({
        externalName: 'gpt-y',
        realModel: 'gpt-real2',
        contextLength: 1000,
        status: 1,
        isFree: true,
        billingPolicy: null,
        rpmLimit: 10,
        tpmLimit: 100,
        pricingUnit: 'request',
        billingConfig: null,
        inputPrice: '2',
        outputPrice: '3',
        cacheInputPrice: '0',
        cacheWritePrice: '0',
        unitPrice: '1',
      }),
    });
    expect(patched.status).toBe(200);
    expect(
      (await app.request('/v1/models/3', { method: 'DELETE', headers: authHeader() })).status,
    ).toBe(200);
    await app.request('/v1/models?q=x', { headers: authHeader() });
    await app.request('/v1/models/3/test', { method: 'POST', headers: authHeader() });
    const badVariant = await app.request('/v1/models', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        externalName: 'v',
        realModel: 'v',
        inputPrice: '0',
        outputPrice: '0',
        cacheInputPrice: '0',
        billingConfig: { strategy: 'variant', params: { selector: 'size' } },
      }),
    });
    expect(badVariant.status).toBe(400);
  });

  it('rate-cards:PATCH/DELETE/卡内用户;fx buffer;catalog import', async () => {
    const app = createAdminApp(
      fakeDeps({
        controlPlane: {
          rates: {
            listCards: async () => ({ rows: [cardRow], total: 1 }),
            createCard: async () => ({ id: 1, name: '标准', coefficient: '1.000' }),
            updateCard: async () => ({ id: 1, name: '标准', coefficient: '0.900' }),
            deleteCard: async () => ({ ok: true as const }),
            listCardUsers: async () => ({
              rows: [{ id: 42, subject: 'user-42', createdAt: new Date('2026-01-01T00:00:00Z') }],
              total: 1,
            }),
            cardHealth: async () => ({ hasGlobalCoefficient: false, coefficient: null }),
          },
          fx: {
            state: async () => ({ mode: 'auto' }) as never,
            refresh: async () => ({ mode: 'auto' }) as never,
            setOverride: async () => ({ mode: 'override' }) as never,
            clearOverride: async () => ({ mode: 'auto' }) as never,
            setBuffer: async () => ({ mode: 'auto' }) as never,
          },
          catalog: {
            listSources: () => [] as never,
            comparison: async () => ({ items: [] }) as never,
            priceHistory: async () => [] as never,
            import: async () => ({ created: 1, skipped: 0 }) as never,
          },
        },
      }),
    );
    const created = await app.request('/v1/rate-cards', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: '标准', description: 'd', coefficient: '0.500' }),
    });
    expect(created.status).toBe(201);
    await app.request('/v1/rate-cards?q=x&order=asc&sort_by=name', { headers: authHeader() });
    const patched = await app.request('/v1/rate-cards/1', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ name: '标准2', description: null, status: 1, coefficient: '0.900' }),
    });
    expect(await patched.json()).toMatchObject({ coefficient: '0.900' });
    expect(
      (await app.request('/v1/rate-cards/1', { method: 'DELETE', headers: authHeader() })).status,
    ).toBe(200);
    const users = await app.request('/v1/rate-cards/1/users?q=u&sort_by=subject', {
      headers: authHeader(),
    });
    expect(await users.json()).toMatchObject({ rows: [{ id: 42, subject: 'user-42' }], total: 1 });
    const health = await app.request('/v1/rate-cards/1/health', { headers: authHeader() });
    expect(await health.json()).toEqual({ hasGlobalCoefficient: false, coefficient: null });

    const buffered = await app.request('/v1/fx/catalog/buffer', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ bufferPct: '2.5' }),
    });
    expect(await buffered.json()).toMatchObject({ mode: 'auto' });
    await app.request('/v1/fx/catalog/refresh', { method: 'POST', headers: json, body: '{}' });

    const history = await app.request('/v1/model-catalog/price-history?externalName=gpt-x', {
      headers: authHeader(),
    });
    expect(await history.json()).toEqual({ entries: [] });
    const imported = await app.request('/v1/model-catalog/import', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        sourceId: 'models-dev',
        apiKey: 'k',
        models: [
          {
            externalName: 'm',
            realModel: 'm',
            inputPrice: '1',
            outputPrice: '2',
            cacheInputPrice: '0',
            cacheWritePrice: '0',
            contextLength: 100,
          },
        ],
      }),
    });
    expect(imported.status).toBe(200);
  });
});

describe('行金额归一(e2e 抓出的存储精度偏差回归×2)', () => {
  it('渠道行 upstreamBudget/Threshold/Consumed 归一;models 行五价格字段归一', async () => {
    const raw = '7.000000000000000000';
    const modelRaw = {
      id: 9,
      externalName: 'm',
      realModel: 'm',
      contextLength: null,
      status: 0,
      inputPrice: raw,
      outputPrice: raw,
      cacheInputPrice: raw,
      cacheWritePrice: raw,
      pricingUnit: 'token',
      unitPrice: raw,
      billingConfig: {},
      isFree: false,
      billingPolicy: null,
      rpmLimit: null,
      tpmLimit: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const app = createAdminApp(
      fakeDeps({
        controlPlane: {
          channels: {
            list: async () => ({
              rows: [
                {
                  id: 1,
                  name: 'c',
                  providerId: 1,
                  providerName: 'p',
                  baseUrlOverride: null,
                  models: null,
                  weight: 1,
                  priority: 0,
                  status: 0,
                  failCount: 0,
                  rpmLimit: null,
                  tpmLimit: null,
                  upstreamBudget: raw,
                  upstreamThreshold: raw,
                  upstreamConsumed: raw,
                  createdAt: new Date('2026-01-01T00:00:00Z'),
                  boundModels: [],
                },
              ],
              total: 1,
            }),
          },
          models: {
            list: async () => ({ rows: [modelRaw], total: 1 }),
          },
        },
      }),
    );
    const channels = await app.request('/v1/channels', { headers: authHeader() });
    expect(await channels.json()).toMatchObject({
      rows: [
        {
          upstreamBudget: '7',
          upstreamThreshold: '7',
          upstreamConsumed: '7',
          upstreamRemaining: '0',
        },
      ],
    });
    const models = await app.request('/v1/models', { headers: authHeader() });
    expect(await models.json()).toMatchObject({
      rows: [
        {
          inputPrice: '7',
          outputPrice: '7',
          cacheInputPrice: '7',
          cacheWritePrice: '7',
          unitPrice: '7',
        },
      ],
    });
  });
});

describe('观测/用户补面', () => {
  it('tracing recent 无过滤分支 + minDurationMs;logs from/to/userId/数值状态码', async () => {
    const app = createAdminApp(
      fakeDeps({
        observability: {
          traces: {
            recent: async () => ({ rows: [], total: 0 }),
            traceDetail: async () => ({ spans: [], services: [], startMs: 0, durationMs: 0 }),
            byRequest: async () => ({ spans: [], services: [], startMs: 0, durationMs: 0 }),
            topology: async () => [] as never,
            stats: async () => ({}) as never,
          },
          requestLogs: {
            list: async () => ({ rows: [], total: 0 }),
          },
          audit: {
            list: async () => ({ rows: [], total: 0 }),
          },
        },
      }),
    );
    expect(
      (
        await app.request('/v1/tracing/recent?errorsOnly=false&minDurationMs=5', {
          headers: authHeader(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/v1/logs?from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z&userId=42&statusCode=500&sort_by=durationMs&order=asc',
          {
            headers: authHeader(),
          },
        )
      ).status,
    ).toBe(200);
  });

  it('keys 列表 userId 过滤;users 列表 status 过滤与 q;资金动词 remark 显式/adjust 正数缺 remark', async () => {
    const app = createAdminApp(
      fakeDeps({
        accounts: {
          adminListUsers: async () => ({ rows: [], total: 0 }),
          adminListKeys: async () => ({ rows: [], total: 0 }),
          userExists: async () => true,
        },
        wallet: {
          credit: async (input: { amount: string }) => ({
            transactionId: 1,
            amount: input.amount,
            balanceAfter: '1',
            replayed: false,
          }),
          statement: async () => [],
          accounts: async () => [],
        },
        operations: {
          run: async (input: { execute: (tx: unknown) => Promise<Record<string, unknown>> }) => ({
            receipt: await input.execute({} as never),
            replayed: false,
          }),
        },
      }),
    );
    expect(
      (
        await app.request('/v1/admin-keys?userId=42&sort_by=name&order=asc', {
          headers: authHeader(),
        })
      ).status,
    ).toBe(200);
    expect(
      (await app.request('/v1/users?status=2&q=x&sort_by=lastLoginAt', { headers: authHeader() }))
        .status,
    ).toBe(200);
    expect((await app.request('/v1/users?enterprise=0', { headers: authHeader() })).status).toBe(
      200,
    );
    const adjust = await app.request('/v1/users/42/adjust', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '5', remark: '补偿' }),
    });
    expect(await adjust.json()).toMatchObject({ ok: true, balanceAfter: '1' });
    expect(
      (
        await app.request('/v1/users/42/transactions?page=3&page_size=10', {
          headers: authHeader(),
        })
      ).status,
    ).toBe(200);
    // from/to 非法日期仍 400(v1 语义)
    const badDates = await app.request('/v1/users/42/transactions?from=not-a-date', {
      headers: authHeader(),
    });
    expect(badDates.status).toBe(400);
    const badGift = await app.request('/v1/users/42/gift', {
      method: 'POST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 'abc' }),
    });
    expect(badGift.status).toBe(400);
    const badId = await app.request('/v1/users/0', { headers: authHeader() });
    expect(badId.status).toBe(400);
    expect(await badId.json()).toMatchObject({ error: { code: 'admin.invalid_param' } });
  });
});

describe('金额出站归一(e2e 抓出的 wire 偏差回归——numeric(38,18) 存储精度不裸出)', () => {
  it('channel-funds 回执与流水行归一;users-funds 回执归一', async () => {
    const raw = '10.000000000000000000';
    const app = createAdminApp(
      fakeDeps({
        controlPlane: {
          channels: {
            listRecharges: async () => ({
              rows: [
                {
                  id: 1,
                  channelId: 2,
                  channelName: 'c',
                  type: 'recharge',
                  amount: raw,
                  balanceAfter: raw,
                  orderNo: null,
                  voucher: null,
                  remark: null,
                  adminId: 7,
                  adminEmail: null,
                  adminDisplayName: null,
                  createdAt: new Date('2026-08-01T00:00:00Z'),
                },
              ],
              total: 1,
            }),
            recharge: async () => ({
              ok: true as const,
              rechargeId: 1,
              balanceAfter: raw,
              replayed: false,
            }),
            adjust: async () => ({
              ok: true as const,
              rechargeId: 2,
              balanceAfter: '7.000000000000000000',
              replayed: false,
            }),
          },
        },
        accounts: { userExists: async () => true },
        wallet: {
          credit: async () => ({
            transactionId: 1,
            amount: raw,
            balanceAfter: raw,
            replayed: false,
          }),
        },
        operations: {
          run: async (input: { execute: (tx: unknown) => Promise<Record<string, unknown>> }) => ({
            receipt: await input.execute({} as never),
            replayed: false,
          }),
        },
      }),
    );
    const recharge = await app.request('/v1/channel-funds/recharge', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ channelId: 2, amount: '10' }),
    });
    expect(await recharge.json()).toMatchObject({ balanceAfter: '10' });
    const adjust = await app.request('/v1/channel-funds/adjust', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ channelId: 2, amount: '-3' }),
    });
    expect(await adjust.json()).toMatchObject({ balanceAfter: '7' });
    const funds = await app.request('/v1/channel-funds?channelId=2', { headers: authHeader() });
    expect(await funds.json()).toMatchObject({ rows: [{ amount: '10', balanceAfter: '10' }] });
    const gift = await app.request('/v1/users/42/gift', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ amount: '10' }),
    });
    expect(await gift.json()).toMatchObject({ balanceBefore: '0', balanceAfter: '10' });
  });
});

describe('可选字段两分支清扫(缺省形态)', () => {
  it('各列表裸调用(过滤字段全部缺省)+ 可选 body 字段缺省', async () => {
    const modelRow2 = {
      id: 3,
      externalName: 'm',
      realModel: 'm',
      contextLength: null,
      status: 0,
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
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
    const app = createAdminApp(
      fakeDeps({
        accounts: {
          adminListUsers: async () => ({ rows: [], total: 0 }),
          adminListKeys: async () => ({ rows: [], total: 0 }),
          adminGetUser: async () => modelRow2 as never,
          userExists: async () => true,
        },
        wallet: {
          accounts: async () => [],
          credit: async (input: { amount: string }) => ({
            transactionId: 1,
            amount: input.amount,
            balanceAfter: '1',
            replayed: false,
          }),
          transfer: async () => ({
            transactionId: 1,
            fromBalanceAfter: '1',
            toBalanceAfter: '0',
            replayed: false,
          }),
          statement: async () => [],
        },
        operations: {
          run: async (input: { execute: (tx: unknown) => Promise<Record<string, unknown>> }) => ({
            receipt: await input.execute({} as never),
            replayed: false,
          }),
        },
        controlPlane: {
          providers: {
            list: async () => ({ rows: [], total: 0 }),
            create: async () => providerRow,
            update: async () => providerRow,
            retire: async () => ({ ok: true as const }),
          },
          channels: {
            list: async () => ({ rows: [], total: 0 }),
            create: async () => ({ id: 1, name: 'c', status: 0, failCount: 0, providerId: 1 }),
            update: async () => ({ id: 1, name: 'c', status: 0, failCount: 0, providerId: 1 }),
            retire: async () => ({ ok: true as const }),
            import: async () => ({ success: 1, failed: 0, total: 1, details: [] }),
            probe: async () => ({ ok: true, durationMs: 1 }),
            recharge: async () => ({
              ok: true as const,
              rechargeId: 1,
              balanceAfter: '1',
              replayed: false,
            }),
            adjust: async () => ({
              ok: true as const,
              rechargeId: 1,
              balanceAfter: '1',
              replayed: false,
            }),
            listRecharges: async () => ({ rows: [], total: 0 }),
          },
          models: {
            list: async () => ({ rows: [], total: 0 }),
            create: async () => modelRow2,
            update: async () => modelRow2,
            retire: async () => ({ ok: true as const }),
            bindChannels: async () => ({ bound: 0 }),
            probe: async () => ({ ok: true, durationMs: 1, results: [] }),
          },
          rates: {
            listCards: async () => ({ rows: [], total: 0 }),
            createCard: async () => ({ id: 1, name: 'x', coefficient: '1.000' }),
            updateCard: async () => ({ id: 1, name: 'x' }),
            deleteCard: async () => ({ ok: true as const }),
            listCardUsers: async () => ({ rows: [], total: 0 }),
            cardHealth: async () => ({ hasGlobalCoefficient: true, coefficient: '1.000' }),
          },
          fx: {
            state: async () => ({ mode: 'auto' }) as never,
            refresh: async () => ({ mode: 'auto' }) as never,
            setOverride: async () => ({ mode: 'auto' }) as never,
            clearOverride: async () => ({ mode: 'auto' }) as never,
            setBuffer: async () => ({ mode: 'auto' }) as never,
          },
          catalog: {
            listSources: () => [] as never,
            comparison: async () => ({ items: [] }) as never,
            priceHistory: async () => [] as never,
            import: async () => ({ created: 0 }) as never,
          },
        },
        observability: {
          traces: {
            recent: async () => ({ rows: [], total: 0 }),
            traceDetail: async () => ({ spans: [], services: [], startMs: 0, durationMs: 0 }),
            byRequest: async () => ({ spans: [], services: [], startMs: 0, durationMs: 0 }),
            topology: async () => [] as never,
            stats: async () => ({}) as never,
          },
          audit: { list: async () => ({ rows: [], total: 0 }), listByTarget: async () => [] },
          requestLogs: { list: async () => ({ rows: [], total: 0 }) },
        },
      }),
    );
    // 各列表裸调用:过滤字段全缺省(q/status/channelId/type/userId/from/to 等_false 分支)
    for (const path of [
      '/v1/providers',
      '/v1/channels',
      '/v1/channel-funds',
      '/v1/models',
      '/v1/rate-cards',
      '/v1/rate-cards/1/users',
      '/v1/admin-keys',
      '/v1/users',
      '/v1/audit-logs',
      '/v1/logs',
      '/v1/tracing/recent',
      '/v1/tracing/topology',
      '/v1/users/42/transactions',
      '/v1/users/42/audit-logs',
    ]) {
      expect((await app.request(path, { headers: authHeader() })).status, path).toBe(200);
    }
    // users 资料(无钱包账户 → 全零富化分支)
    await app.request('/v1/users/42', { headers: authHeader() });
    // 调账正/负与赠送:remark 缺省分支全覆盖
    await app.request('/v1/users/42/adjust', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ amount: '-3' }),
    });
    const badAmount = await app.request('/v1/users/42/adjust', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ amount: 'abc' }),
    });
    expect(badAmount.status).toBe(400);
    await app.request('/v1/users/42/gift', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ amount: '1', remark: '活动' }),
    });
    // 渠道进货:可选字段(orderNo/voucherDataUrl/remark)缺省
    await app.request('/v1/channel-funds/recharge', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ channelId: 1, amount: '1' }),
    });
    // 模型创建:可选字段缺省 + unitPrice 字符串分支
    await app.request('/v1/models', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        externalName: 'a',
        realModel: 'b',
        inputPrice: '1',
        outputPrice: '1',
        cacheInputPrice: '1',
        unitPrice: '0.5',
      }),
    });
    // 模型补丁:仅 status(价格组缺省)与仅 externalName
    await app.request('/v1/models/3', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 0 }),
    });
    await app.request('/v1/models/3', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ externalName: 'c' }),
    });
    // 目录导入:apiKey 缺省 + contextLength 缺省
    await app.request('/v1/model-catalog/import', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        sourceId: 'models-dev',
        models: [
          {
            externalName: 'm',
            realModel: 'm',
            inputPrice: '1',
            outputPrice: '1',
            cacheInputPrice: '1',
            cacheWritePrice: '1',
          },
        ],
      }),
    });
    // fx 刷新空 body(catch 缺省分支)
    await app.request('/v1/fx/catalog/refresh', { method: 'POST', headers: authHeader() });
    // 路径 id 非数字
    const badPath = await app.request('/v1/users/abc', { headers: authHeader() });
    expect(badPath.status).toBe(400);
  });
});
