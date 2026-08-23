/**
 * 分支补面 V（收口轮）：admin-list 信封缺省、auth 边缘、models/providers/
 * rate-cards/subscriptions/users 的可选字段缺席分支。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installNextStubs, mockFetch, type MockResponse } from './harness';

async function loadModule(path: string, responses: MockResponse[]) {
  vi.resetModules();
  const { fetchStub } = mockFetch(responses);
  vi.stubGlobal('fetch', fetchStub);
  installNextStubs();
  return await import(path);
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

describe('admin-list 信封缺省分支', () => {
  it('rows/total 缺失时回落空数组与 0（信封宽容解析）', async () => {
    const mod = await loadModule('../src/server/admin-list', [{ status: 200, body: {} }]);
    const res = await mod.fetchAdminList('/v1/users', { pageSize: 20, page: 1 });
    expect(res).toEqual({ rows: [], total: 0, error: null });
  });
});

describe('auth 边缘分支', () => {
  it('login：200 但无 token → noToken；非 2xx 无 message → 状态码兜底文案', async () => {
    const mod = await loadModule('../src/server/auth-actions', [
      { status: 200, body: {} },
      { status: 500, body: {} },
    ]);
    const fd = new FormData();
    fd.set('email', 'a@b.c');
    fd.set('password', 'pw');
    await expect(mod.loginAction(fd)).resolves.toEqual({ error: 'noToken' });
    await expect(mod.loginAction(fd)).resolves.toEqual({ error: expect.stringContaining('500') });
  });

  it('verify：200 无 token → 状态兜底；空 challenge 请求照常', async () => {
    const mod = await loadModule('../src/server/auth-actions', [{ status: 200, body: {} }]);
    await expect(mod.verifyLoginAction('ch', '123456')).resolves.toEqual({
      error: expect.any(String),
    });
  });
});

describe('可选字段缺席分支（翻 ?. 与 || 的 false 侧）', () => {
  it('users：remark 字段整体缺席', async () => {
    const mod = await loadModule('../src/server/users-actions', [{}, {}, {}]);
    await mod.adjustBalanceAction(1, { amount: '1' } as never);
    await mod.giftUserAction(1, { amount: '1' } as never);
    await mod.setUserStatusAction(1, { status: 0, freezeReason: undefined });
  });

  it('providers update：单字段；channels create：带 baseUrlOverride/权重缺省', async () => {
    const pr = await loadModule('../src/server/providers-actions', [{}]);
    await pr.updateProviderAction(1, { status: 0 });
    const ch = await loadModule('../src/server/channels-actions', [{}]);
    const create = ch.createChannelAction as unknown as (
      a: Record<string, unknown>,
    ) => Promise<unknown>;
    await create({ providerId: 1, name: 'c', apiKey: 'k', baseUrlOverride: 'https://o' });
  });

  it('models：update 空补丁 + test 错误对象形态（{code,message}）', async () => {
    const mod = await loadModule('../src/server/models-actions', [
      {},
      { status: 200, body: { results: [{ ok: false, error: { code: 'up', message: 'boom' } }] } },
    ]);
    await mod.updateModelAction(1, {});
    await mod.testModelAction(1);
  });

  it('rate-cards：update 单字段；subscriptions change 仅必要字段', async () => {
    const rc = await loadModule('../src/server/rate-cards-actions', [{}]);
    await rc.updateRateCardAction(1, { coefficient: '3' });
    const su = await loadModule('../src/server/subscriptions-actions', [{}]);
    await su.changeSubscriptionAction(1, { targetPlanId: 2, quantity: 1 });
  });

  it('plans grant：非整数 userId 前置拒绝', async () => {
    const mod = await loadModule('../src/server/plans-actions', []);
    await expect(mod.grantPackAction(1, 1.5)).resolves.toEqual({ error: 'invalidUserId' });
  });

  it('channel-funds：orderNo 空串（|| undefined 分支）', async () => {
    const mod = await loadModule('../src/server/channel-funds-actions', [{}]);
    await mod.rechargeChannelAction({ channelId: 1, amount: '1', orderNo: '' });
  });

  it('model-catalog：import 无 sourceId（可选项缺席）', async () => {
    const mod = await loadModule('../src/server/model-catalog-actions', [{}]);
    const imp = mod.importCatalogAction as unknown as (
      a: Record<string, unknown>,
    ) => Promise<unknown>;
    await imp({
      models: [{ externalName: 'm', realModel: 'r', inputPrice: '1', outputPrice: '1' }],
    });
  });
});
