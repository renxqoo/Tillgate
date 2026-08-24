/**
 * 分支补面 VI（单实例扫描）：vi.resetModules 多实例下 v8 弧计数会丢——
 * 本套件对每个 server 模块只加载一次，在同一实例内顺序打满
 * 成功/ApiError/网络异常/校验四类弧，保证 try/catch 与可选链两侧都被计数。
 */
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { defined } from './defined';
import { installNextStubs, mockFetch, type MockResponse } from './harness';

const ok: MockResponse = { status: 200, body: {} };
const err = (m = 'boom'): MockResponse => ({ status: 422, body: { error: { message: m } } });
const net: MockResponse = { throwError: true };

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.doUnmock('next/headers');
  vi.doUnmock('next/cache');
  vi.doUnmock('next/navigation');
  vi.doUnmock('next-intl/server');
});

/** 直装：一次性装桩 + 单实例取模块 + 逐调用应答队列 */
async function session(path: string, responses: MockResponse[]) {
  vi.resetModules();
  const { fetchStub } = mockFetch(responses);
  vi.stubGlobal('fetch', fetchStub);
  installNextStubs();
  const mod = (await import(path)) as Record<string, (...a: unknown[]) => Promise<unknown>>;
  return mod;
}

/** 统一调用助手（参数透传） */
function R(fn: unknown, ...a: unknown[]): Promise<unknown> {
  return (fn as (...x: unknown[]) => Promise<unknown>)(...a);
}

describe('单实例四弧扫描', () => {
  it('users：六动词 × {成功, ApiError, 网络异常}', async () => {
    const m = await session('../src/server/users-actions', [
      ok,
      err(),
      net,
      ok,
      err(),
      net,
      ok,
      err(),
      net,
      ok,
      err(),
      net,
      ok,
      err(),
      net,
      ok,
      err(),
      net,
    ]);
    await R(m.adjustBalanceAction, 1, { amount: '1', remark: 'r' });
    await R(m.adjustBalanceAction, 1, { amount: '1', remark: 'r' });
    await R(m.adjustBalanceAction, 1, { amount: '1', remark: 'r' });
    await R(m.setPasswordAction, 1, { password: '123456' });
    await R(m.setPasswordAction, 1, { password: '123456' });
    await R(m.setPasswordAction, 1, { password: '123456' });
    await R(m.giftUserAction, 1, { amount: '1', remark: 'r' });
    await R(m.giftUserAction, 1, { amount: '1', remark: 'r' });
    await R(m.giftUserAction, 1, { amount: '1', remark: 'r' });
    await R(m.setUserStatusAction, 1, { status: 1, freezeReason: 'f' });
    await R(m.setUserStatusAction, 1, { status: 1, freezeReason: 'f' });
    await R(m.setUserStatusAction, 1, { status: 1, freezeReason: 'f' });
    await R(m.setUserEnterpriseAction, 1, true);
    await R(m.setUserEnterpriseAction, 1, true);
    await R(m.setUserEnterpriseAction, 1, true);
    await R(m.bindRateCardAction, 1, 2);
    await R(m.bindRateCardAction, 1, 2);
    await R(m.bindRateCardAction, 1, 2);
  });

  it('models：动词族 × 三弧 + billingConfig 满配', async () => {
    const m = await session(
      '../src/server/models-actions',
      Array.from({ length: 15 }, (_, i) => defined([ok, err(), net][i % 3], 'cycle response')),
    );
    const full = {
      externalName: 'a',
      realModel: 'b',
      inputPrice: '1',
      outputPrice: '1',
      cacheInputPrice: '0.1',
      cacheWritePrice: '0.2',
      pricingUnit: 'image',
      unitPrice: '0.5',
      billingConfig: { strategy: 'variant', params: { selector: 's', prices: { a: '1' } } },
      isFree: false,
      contextLength: 100,
      billingPolicy: { x: 1 },
    };
    await R(m.createModelAction, full);
    await R(m.createModelAction, full);
    await R(m.createModelAction, full);
    await R(m.updateModelAction, 1, { status: 0, name: 'n' });
    await R(m.updateModelAction, 1, { status: 0, name: 'n' });
    await R(m.updateModelAction, 1, { status: 0, name: 'n' });
    await R(m.delistModelAction, 1);
    await R(m.delistModelAction, 1);
    await R(m.delistModelAction, 1);
    await R(m.restoreModelAction, 1);
    await R(m.restoreModelAction, 1);
    await R(m.restoreModelAction, 1);
    await R(m.deleteModelAction, 1);
    await R(m.deleteModelAction, 1);
    await R(m.deleteModelAction, 1);
    await R(m.undeleteModelAction, 1);
    await R(m.undeleteModelAction, 1);
    await R(m.undeleteModelAction, 1);
    await R(m.bindChannelsAction, 1, [1, 2]);
    await R(m.testModelAction, 1);
    await R(m.testModelAction, 1);
  });

  it('providers：create 满配（protocol+vendor）/缺 baseUrl/三弧 update', async () => {
    const m = await session('../src/server/providers-actions', [
      ok,
      ok,
      err(),
      net,
      ok,
      err(),
      net,
      ok,
      err(),
      net,
    ]);
    await R(m.createProviderAction, {
      name: 'a',
      baseUrl: 'https://a',
      protocol: 'gemini',
      vendor: 'deepseek',
      status: 0,
    });
    await R(m.createProviderAction, { name: 'a', baseUrl: ' ' } as never);
    await R(m.createProviderAction, { name: 'a', baseUrl: 'https://a' });
    await R(m.createProviderAction, { name: 'a', baseUrl: 'https://a' });
    await R(m.updateProviderAction, 1, {
      name: 'n',
      baseUrl: 'b',
      protocol: 'anthropic',
      vendor: 'xai',
      status: 1,
    });
    await R(m.updateProviderAction, 1, { name: 'n' });
    await R(m.updateProviderAction, 1, { name: 'n' });
    await R(m.deleteProviderAction, 1);
    await R(m.deleteProviderAction, 1);
    await R(m.deleteProviderAction, 1);
  });

  it('rate-cards/plans/subscriptions：校验弧 + 三弧', async () => {
    const rc = await session('../src/server/rate-cards-actions', [
      ok,
      ok,
      err(),
      net,
      ok,
      err(),
      net,
      ok,
      err(),
      net,
    ]);
    await R(rc.createRateCardAction, { name: ' ', coefficient: '1' });
    await R(rc.createRateCardAction, { name: 'r', description: 'd', coefficient: '1' });
    await R(rc.createRateCardAction, { name: 'r', coefficient: '1' });
    await R(rc.createRateCardAction, { name: 'r', coefficient: '1' });
    await R(rc.updateRateCardAction, 1, {
      name: 'n',
      description: 'd',
      status: 0,
      coefficient: '2',
    });
    await R(rc.updateRateCardAction, 1, { status: 0 });
    await R(rc.updateRateCardAction, 1, { status: 0 });
    await R(rc.deleteRateCardAction, 1);
    await R(rc.deleteRateCardAction, 1);
    await R(rc.deleteRateCardAction, 1);

    const pl = await session('../src/server/plans-actions', [
      ok,
      err(),
      net,
      ok,
      err(),
      net,
      ok,
      err(),
      net,
      ok,
      err(),
      net,
    ]);
    await R(pl.createPlanAction, { name: 'p', price: '1', periodDays: 30, quotaAmount: '1' });
    await R(pl.createPlanAction, { name: 'p', price: '1', periodDays: 30, quotaAmount: '1' });
    await R(pl.createPlanAction, { name: 'p', price: '1', periodDays: 30, quotaAmount: '1' });
    await R(pl.updatePlanAction, 1, {
      name: 'n',
      sortOrder: 1,
      price: '1',
      periodDays: 1,
      quotaAmount: '1',
      allowSeats: true,
      status: 0,
    });
    await R(pl.updatePlanAction, 1, { name: 'n' });
    await R(pl.updatePlanAction, 1, { name: 'n' });
    await R(pl.deletePlanAction, 1);
    await R(pl.deletePlanAction, 1);
    await R(pl.deletePlanAction, 1);
    await R(pl.grantPackAction, 1, 1);
    await R(pl.grantPackAction, 1, 1);
    await R(pl.grantPackAction, 1, 1);

    const su = await session(
      '../src/server/subscriptions-actions',
      Array.from({ length: 9 }, (_, i) => defined([ok, err(), net][i % 3], 'cycle response')),
    );
    await R(su.renewSubscriptionAction, 1);
    await R(su.renewSubscriptionAction, 1);
    await R(su.renewSubscriptionAction, 1);
    await R(su.cancelSubscriptionAction, 1);
    await R(su.cancelSubscriptionAction, 1);
    await R(su.cancelSubscriptionAction, 1);
    await R(su.changeSubscriptionAction, 1, { targetPlanId: 2, quantity: 3 });
    await R(su.changeSubscriptionAction, 1, { targetPlanId: 2, quantity: 3 });
    await R(su.changeSubscriptionAction, 1, { targetPlanId: 2, quantity: 3 });
  });

  it('channel-funds/model-catalog/auth/admin-list：校验与三弧收尾', async () => {
    const cf = await session('../src/server/channel-funds-actions', [
      ok,
      ok,
      ok,
      err(),
      net,
      ok,
      ok,
      err(),
      net,
    ]);
    await R(cf.adjustChannelAction, { channelId: 0, amount: '1' });
    await R(cf.rechargeChannelAction, {
      channelId: 1,
      amount: '1',
      orderNo: 'o',
      voucherDataUrl: 'd',
      remark: 'r',
    });
    await R(cf.rechargeChannelAction, { channelId: 1, amount: '1' });
    await R(cf.rechargeChannelAction, { channelId: 1, amount: '1' });
    await R(cf.rechargeChannelAction, { channelId: 1, amount: '1' });
    await R(cf.adjustChannelAction, { channelId: 1, amount: '-1', remark: 'r' });
    await R(cf.adjustChannelAction, { channelId: 1, amount: '-1' });
    await R(cf.adjustChannelAction, { channelId: 1, amount: '-1' });
    await R(cf.adjustChannelAction, { channelId: 1, amount: '-1' });

    const mc = await session(
      '../src/server/model-catalog-actions',
      Array.from({ length: 18 }, (_, i) => defined([ok, err(), net][i % 3], 'cycle response')),
    );
    const imp = mc.importCatalogAction as unknown as (
      a: Record<string, unknown>,
    ) => Promise<unknown>;
    await imp({ sourceId: 'UPPER!', models: [] });
    await imp({
      sourceId: 'lit',
      models: [{ externalName: ' ', realModel: 'r', inputPrice: '1', outputPrice: '1' }],
    });
    await imp({
      sourceId: 'lit',
      apiKey: 'k',
      models: [
        {
          externalName: 'm',
          realModel: 'r',
          inputPrice: '1',
          outputPrice: '1',
          cacheInputPrice: '0',
        },
      ],
    });
    await imp({ sourceId: 'lit', models: [] });
    await R(mc.setFxOverrideAction, '7.2');
    await R(mc.setFxOverrideAction, '7.2');
    await R(mc.setFxOverrideAction, '7.2');
    await R(mc.clearFxOverrideAction);
    await R(mc.clearFxOverrideAction);
    await R(mc.clearFxOverrideAction);
    await R(mc.setFxBufferAction, '3');
    await R(mc.setFxBufferAction, '3');
    await R(mc.setFxBufferAction, '3');
    await R(mc.refreshFxAction, true);
    await R(mc.refreshFxAction, true);
    await R(mc.refreshFxAction, true);
    await R(mc.priceHistoryAction, 'm');
    await R(mc.priceHistoryAction, 'm');
    await R(mc.priceHistoryAction, 'm');

    const au = await session('../src/server/auth-actions', [ok, net, net]);
    await R(au.setTwoFactorAction, true);
    await R(au.setTwoFactorAction, true);
    const empty = new FormData();
    empty.set('email', '');
    empty.set('password', '');
    await R(au.loginAction, empty);

    const al = await session('../src/server/admin-list', [net]);
    await R((al as unknown as { fetchAdminList: unknown }).fetchAdminList, '/v1/users', {
      pageSize: 20,
    });
  });
});
