/**
 * server actions 覆盖补面：models/plans/channel-funds/subscriptions/marketing/
 * providers/channels 的创建编辑与前置校验分支（与 server-actions.test.ts 同装置）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installNextStubs, mockFetch, type FetchCall } from './harness';

async function loadModule(path: string, responses: Array<{ status?: number; body?: unknown }>) {
  vi.resetModules();
  const { fetchStub, calls } = mockFetch(responses);
  vi.stubGlobal('fetch', fetchStub);
  const stubs = installNextStubs();
  const mod = await import(path);
  return { mod, calls, ...stubs };
}

function last(calls: FetchCall[]): FetchCall {
  return calls[calls.length - 1]!;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.doUnmock('next/headers');
  vi.doUnmock('next/cache');
  vi.doUnmock('next/navigation');
  vi.doUnmock('next-intl/server');
});

describe('models-actions 覆盖面', () => {
  const createInput = {
    externalName: 'gpt-x',
    realModel: 'real-x',
    inputPrice: '1',
    outputPrice: '2',
  };

  it('create：空名被拒；合法输入展开默认值（token/0/isFree false）', async () => {
    const { mod, calls } = await loadModule('../src/server/models-actions', [{}]);
    await expect(mod.createModelAction({ ...createInput, externalName: ' ' })).resolves.toEqual({
      error: 'nameRequired',
    });
    expect(calls).toHaveLength(0);
    await expect(mod.createModelAction(createInput)).resolves.toEqual({});
    expect(last(calls)).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/models'),
      body: { pricingUnit: 'token', cacheInputPrice: '0', isFree: false },
    });
  });

  it('create：单位计价/缓存写价/上下文长度等可选字段仅在有值时携带', async () => {
    const { mod, calls } = await loadModule('../src/server/models-actions', [{}]);
    await mod.createModelAction({
      ...createInput,
      pricingUnit: 'image',
      unitPrice: '0.1',
      cacheWritePrice: '0.05',
      contextLength: 8192,
    });
    const body = last(calls).body as Record<string, unknown>;
    expect(body.pricingUnit).toBe('image');
    expect(body.unitPrice).toBe('0.1');
    expect(body.cacheWritePrice).toBe('0.05');
    expect(body.contextLength).toBe(8192);
    expect(body).not.toHaveProperty('billingConfig');
  });

  it('update/restore/delist/delete/undelete：动词族', async () => {
    const { mod, calls } = await loadModule('../src/server/models-actions', [{}, {}, {}, {}, {}]);
    await mod.updateModelAction(4, { inputPrice: '9' });
    await mod.restoreModelAction(4);
    await mod.delistModelAction(4);
    await mod.deleteModelAction(4);
    await mod.undeleteModelAction(4);
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'PATCH', 'PATCH', 'DELETE', 'POST']);
    expect(calls[2]).toMatchObject({
      url: expect.stringContaining('/v1/models/4'),
      body: { status: 1 },
    });
    expect(calls[4]).toMatchObject({
      url: expect.stringContaining('/v1/models/4/restore'),
    });
  });
});

describe('plans-actions 覆盖面', () => {
  it('create：空名拒绝；成功 POST', async () => {
    const { mod, calls } = await loadModule('../src/server/plans-actions', [{}]);
    await expect(mod.createPlanAction({ name: ' ', price: '1', periodDays: 30 })).resolves.toEqual({
      error: 'nameRequired',
    });
    await expect(
      mod.createPlanAction({ name: 'pro', price: '19.9', periodDays: 30, quotaAmount: '100' }),
    ).resolves.toEqual({});
    expect(last(calls)).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/plans'),
    });
  });

  it('update/delete/grant：动词族', async () => {
    const { mod, calls } = await loadModule('../src/server/plans-actions', [{}, {}, {}]);
    await mod.updatePlanAction(2, { status: 0 });
    await mod.deletePlanAction(2);
    const grant = mod.grantPackAction as (a: unknown, b: unknown, c?: unknown) => Promise<unknown>;
    await grant(11, 2, 1);
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'DELETE', 'POST']);
  });
});

describe('channel-funds-actions 覆盖面', () => {
  it('recharge：无渠道/非正金额被拒；合法走 recharge 端点带凭证', async () => {
    const { mod, calls } = await loadModule('../src/server/channel-funds-actions', [{}]);
    await expect(mod.rechargeChannelAction({ channelId: 0, amount: '1' })).resolves.toEqual({
      error: 'channelRequired',
    });
    await expect(mod.rechargeChannelAction({ channelId: 1, amount: '-5' })).resolves.toEqual({
      error: 'amountPositive',
    });
    await expect(
      mod.rechargeChannelAction({
        channelId: 1,
        amount: '50',
        orderNo: ' O1 ',
        voucherDataUrl: 'data:image/png;base64,xx',
      }),
    ).resolves.toEqual({});
    expect(last(calls)).toMatchObject({
      url: expect.stringContaining('/v1/channel-funds/recharge'),
      body: {
        channelId: 1,
        amount: '50',
        orderNo: 'O1',
        voucherDataUrl: 'data:image/png;base64,xx',
      },
    });
  });

  it('adjust：零金额被拒；有符号金额走 adjust 端点', async () => {
    const { mod, calls } = await loadModule('../src/server/channel-funds-actions', [{}]);
    await expect(mod.adjustChannelAction({ channelId: 1, amount: '0' })).resolves.toEqual({
      error: 'amountNonZero',
    });
    await expect(
      mod.adjustChannelAction({ channelId: 1, amount: '-2.5', remark: 'r' }),
    ).resolves.toEqual({});
    expect(last(calls)).toMatchObject({ url: expect.stringContaining('/v1/channel-funds/adjust') });
  });
});

describe('subscriptions change/grant', () => {
  it('change：目标套餐与数量进 body', async () => {
    const { mod, calls } = await loadModule('../src/server/subscriptions-actions', [{}]);
    await mod.changeSubscriptionAction(6, { targetPlanId: 2, quantity: 3 });
    expect(last(calls)).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/subscriptions/6/change'),
      body: { targetPlanId: 2, quantity: 3 },
    });
  });
});

describe('marketing 保存', () => {
  it('PUT 全量表单 + revalidate', async () => {
    const { mod, calls } = await loadModule('../src/server/marketing-actions', [{}]);
    await expect(
      mod.saveMarketingSettingsAction({
        signupGiftAmount: '1',
        referralSignupBonus: '2',
        referralCommissionRate: '0.1',
      }),
    ).resolves.toEqual({ ok: true });
    expect(last(calls)).toMatchObject({
      method: 'PUT',
      url: expect.stringContaining('/v1/marketing/settings'),
    });
  });
});

describe('providers/channels 剩余分支', () => {
  it('providers create 校验（名字/baseUrl 必填）与错误信封', async () => {
    const { mod } = await loadModule('../src/server/providers-actions', [
      { status: 400, body: { error: { message: 'bad protocol' } } },
    ]);
    await expect(mod.createProviderAction({ name: '', baseUrl: '' })).resolves.toEqual({
      error: expect.any(String),
    });
    await expect(
      mod.createProviderAction({ name: 'p', baseUrl: 'https://x', protocol: 'nope' }),
    ).resolves.toEqual({ error: 'bad protocol' });
  });

  it('providers delete/undelete：动词族', async () => {
    const { mod, calls } = await loadModule('../src/server/providers-actions', [{}, {}]);
    await mod.deleteProviderAction(3);
    await mod.undeleteProviderAction(3);
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'POST']);
    expect(calls[1]).toMatchObject({
      url: expect.stringContaining('/v1/providers/3/restore'),
    });
  });

  it('channels create/update/import 动词族', async () => {
    const { mod, calls } = await loadModule('../src/server/channels-actions', [{}, {}, {}, {}, {}]);
    const create = mod.createChannelAction as unknown as (
      a: Record<string, unknown>,
    ) => Promise<unknown>;
    const res = await create({
      providerId: 1,
      name: 'c',
      apiKey: 'k',
      models: 'm1, m2',
      weight: 1,
      priority: 1,
    });
    expect(res).toEqual({});
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/channels'),
    });
    const update = mod.updateChannelAction as (a: unknown, b: unknown) => Promise<unknown>;
    await update(1, { name: 'c2' });
    expect(calls[1]).toMatchObject({ method: 'PATCH' });
    const imp = mod.importChannelsAction as (a: unknown) => Promise<unknown>;
    await imp([{ providerId: 1, name: 'i', apiKey: 'k' }]);
    expect(calls[2]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/channels/import'),
    });
    await mod.deleteChannelAction(2);
    await mod.undeleteChannelAction(2);
    expect(calls[3]).toMatchObject({ method: 'DELETE' });
    expect(calls[4]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/channels/2/restore'),
    });
  });
});

describe('rate-cards 校验分支', () => {
  it('create：系数原样上送（合法性由后端 zod 收口——前端零第二套校验）', async () => {
    const { mod, calls } = await loadModule('../src/server/rate-cards-actions', [{}]);
    await expect(mod.createRateCardAction({ name: 'r', coefficient: '1.25' })).resolves.toEqual({});
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { name: 'r', coefficient: '1.25' },
    });
  });
});

describe('redeem 校验分支', () => {
  it('generate：金额/数量/名字三重校验', async () => {
    const { mod, calls } = await loadModule('../src/server/redeem-batches-actions', []);
    await expect(mod.generateBatchAction({ name: 'n', amount: '0', count: 5 })).resolves.toEqual({
      error: 'amountPositive',
    });
    await expect(mod.generateBatchAction({ name: 'n', amount: '5', count: 0 })).resolves.toEqual({
      error: 'countRange',
    });
    await expect(mod.generateBatchAction({ name: ' ', amount: '5', count: 5 })).resolves.toEqual({
      error: 'nameRequired',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('model-catalog import 分支', () => {
  it('importCatalog：无模型被拒；带源导入 POST', async () => {
    const { mod, calls } = await loadModule('../src/server/model-catalog-actions', [{}]);
    const imp = mod.importCatalogAction as (a: unknown) => Promise<unknown>;
    await imp({ models: [] });
    await imp({
      sourceId: 'lit',
      models: [{ externalName: 'm', realModel: 'r', inputPrice: '1', outputPrice: '1' }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/model-catalog/import'),
    });
  });

  it('fx override/buffer 数值原样上送（后端域校验收口）', async () => {
    const { mod, calls } = await loadModule('../src/server/model-catalog-actions', [{}, {}]);
    await expect(mod.setFxOverrideAction('7.25')).resolves.toEqual({});
    await expect(mod.setFxBufferAction('3')).resolves.toEqual({});
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'PUT']);
  });
});

describe('users 错误信封分支', () => {
  it('全部动词的 ApiError message 透传', async () => {
    const { mod } = await loadModule('../src/server/users-actions', [
      { status: 400, body: { error: { message: 'e1' } } },
      { status: 400, body: { error: { message: 'e2' } } },
      { status: 400, body: { error: { message: 'e3' } } },
      { status: 400, body: { error: { message: 'e4' } } },
      { status: 400, body: { error: { message: 'e5' } } },
      { status: 400, body: { error: { message: 'e6' } } },
    ]);
    await expect(mod.adjustBalanceAction(1, { amount: '1', remark: '' })).resolves.toEqual({
      error: 'e1',
    });
    await expect(mod.setPasswordAction(1, { password: '123456' })).resolves.toEqual({
      error: 'e2',
    });
    await expect(mod.giftUserAction(1, { amount: '1', remark: '' })).resolves.toEqual({
      error: 'e3',
    });
    await expect(mod.setUserStatusAction(1, { status: 1 })).resolves.toEqual({ error: 'e4' });
    await expect(mod.setUserEnterpriseAction(1, true)).resolves.toEqual({ error: 'e5' });
    await expect(mod.bindRateCardAction(1, 2)).resolves.toEqual({ error: 'e6' });
  });
});

describe('tracing 入参守卫', () => {
  it('traceId 非十六进制被拒（无 fetch）；requestId 非法字符被拒', async () => {
    const { mod, calls } = await loadModule('../src/server/tracing-actions', []);
    await expect(mod.fetchTraceDetail('../etc')).resolves.toEqual({ error: 'invalidTraceId' });
    await expect(mod.fetchTraceDetailByRequestId('bad id!')).resolves.toEqual({
      error: 'invalidRequestId',
    });
    expect(calls).toHaveLength(0);
  });
});
