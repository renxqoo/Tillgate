/**
 * 分支补面 IV：结构化 ApiError（非 2xx + 错误信封）逐动作翻面——
 * 与 branches 套件的网络异常分支互补，覆盖 `e instanceof ApiError ? message : 兜底` 的两侧。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installNextStubs, mockFetch, type MockResponse } from './harness';

const err = (message: string): MockResponse => ({
  status: 422,
  body: { error: { code: 'biz.x', message } },
});

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

describe('ApiError 信封透传（英文 message 上浮到 {error}）', () => {
  it('users 全六动词', async () => {
    const mod = await loadModule(
      '../src/server/users-actions',
      Array.from({ length: 6 }, () => err('u-e')),
    );
    await expect(mod.adjustBalanceAction(1, { amount: '1', remark: '' })).resolves.toEqual({
      error: 'u-e',
    });
    await expect(mod.setPasswordAction(1, { password: '123456' })).resolves.toEqual({
      error: 'u-e',
    });
    await expect(mod.giftUserAction(1, { amount: '1', remark: '' })).resolves.toEqual({
      error: 'u-e',
    });
    await expect(mod.setUserStatusAction(1, { status: 0 })).resolves.toEqual({ error: 'u-e' });
    await expect(mod.setUserEnterpriseAction(1, false)).resolves.toEqual({ error: 'u-e' });
    await expect(mod.bindRateCardAction(1, null)).resolves.toEqual({ error: 'u-e' });
  });

  it('providers/channels/models', async () => {
    const p = await loadModule('../src/server/providers-actions', [
      err('p-e'),
      err('p-e'),
      err('p-e'),
    ]);
    await expect(p.createProviderAction({ name: 'a', baseUrl: 'https://a' })).resolves.toEqual({
      error: 'p-e',
    });
    await expect(p.updateProviderAction(1, { name: 'b' })).resolves.toEqual({ error: 'p-e' });
    await expect(p.deleteProviderAction(1)).resolves.toEqual({ error: 'p-e' });

    const c = await loadModule('../src/server/channels-actions', [
      err('c-e'),
      err('c-e'),
      err('c-e'),
      err('c-e'),
      err('c-e'),
    ]);
    const create = c.createChannelAction as unknown as (
      a: Record<string, unknown>,
    ) => Promise<{ error?: string }>;
    await expect(create({ name: 'c', apiKey: 'k' })).resolves.toEqual({ error: 'c-e' });
    const update = c.updateChannelAction as unknown as (
      a: number,
      b: Record<string, unknown>,
    ) => Promise<{ error?: string }>;
    await expect(update(1, { name: 'x' })).resolves.toEqual({ error: 'c-e' });
    await expect(c.deleteChannelAction(1)).resolves.toEqual({ error: 'c-e' });
    await expect(c.testChannelAction(1)).resolves.toMatchObject({ error: expect.any(String) });
    const imp = c.importChannelsAction as unknown as (
      a: Array<Record<string, unknown>>,
    ) => Promise<{ error?: string }>;
    await expect(imp([{ providerId: 1, name: 'i', apiKey: 'k' }])).resolves.toEqual({
      error: 'c-e',
    });

    const m = await loadModule('../src/server/models-actions', [
      err('m-e'),
      err('m-e'),
      err('m-e'),
      err('m-e'),
    ]);
    await expect(
      m.createModelAction({ externalName: 'a', realModel: 'b', inputPrice: '1', outputPrice: '1' }),
    ).resolves.toEqual({ error: 'm-e' });
    await expect(m.updateModelAction(1, { status: 0 })).resolves.toEqual({ error: 'm-e' });
    await expect(m.deleteModelAction(1)).resolves.toEqual({ error: 'm-e' });
    await expect(m.restoreModelAction(1)).resolves.toEqual({ error: 'm-e' });
  });

  it('billing 族（plans/rate-cards/channel-funds/redeem/subscriptions/billing-operations/payment-orders）', async () => {
    const pl = await loadModule('../src/server/plans-actions', [
      err('pl-e'),
      err('pl-e'),
      err('pl-e'),
      err('pl-e'),
    ]);
    await expect(pl.createPlanAction({ name: 'n', price: '1', periodDays: 30 })).resolves.toEqual({
      error: 'pl-e',
    });
    await expect(pl.updatePlanAction(1, { name: 'n' })).resolves.toEqual({ error: 'pl-e' });
    await expect(pl.deletePlanAction(1)).resolves.toEqual({ error: 'pl-e' });
    await expect(pl.grantPackAction(1, 1)).resolves.toEqual({ error: 'pl-e' });

    const rc = await loadModule('../src/server/rate-cards-actions', [
      err('rc-e'),
      err('rc-e'),
      err('rc-e'),
    ]);
    await expect(rc.createRateCardAction({ name: 'r', coefficient: '1' })).resolves.toEqual({
      error: 'rc-e',
    });
    await expect(rc.updateRateCardAction(1, { status: 0 })).resolves.toEqual({ error: 'rc-e' });
    await expect(rc.deleteRateCardAction(1)).resolves.toEqual({ error: 'rc-e' });

    const cf = await loadModule('../src/server/channel-funds-actions', [err('cf-e'), err('cf-e')]);
    await expect(cf.rechargeChannelAction({ channelId: 1, amount: '1' })).resolves.toEqual({
      error: 'cf-e',
    });
    await expect(cf.adjustChannelAction({ channelId: 1, amount: '1' })).resolves.toEqual({
      error: 'cf-e',
    });

    const rb = await loadModule('../src/server/redeem-batches-actions', [err('rb-e'), err('rb-e')]);
    await expect(
      rb.generateBatchAction({ name: 'n', amount: '1', count: 1 }),
    ).resolves.toMatchObject({ error: 'rb-e' });
    await expect(rb.revokeCodeAction(1)).resolves.toEqual({ error: 'rb-e' });

    const su = await loadModule('../src/server/subscriptions-actions', [
      err('su-e'),
      err('su-e'),
      err('su-e'),
    ]);
    await expect(su.renewSubscriptionAction(1)).resolves.toEqual({ error: 'su-e' });
    await expect(su.cancelSubscriptionAction(1)).resolves.toEqual({ error: 'su-e' });
    await expect(su.changeSubscriptionAction(1, { targetPlanId: 1, quantity: 1 })).resolves.toEqual(
      { error: 'su-e' },
    );

    const bo = await loadModule('../src/server/billing-operations-actions', [
      err('bo-e'),
      err('bo-e'),
    ]);
    await expect(
      bo.retryDeadBillingRequest({ requestId: 'r', expectedRevision: 1, reason: 'x' }),
    ).resolves.toEqual({ error: 'bo-e' });
    await expect(
      bo.abandonDeadBillingRequest({ requestId: 'r', expectedRevision: 1, reason: 'x' }),
    ).resolves.toEqual({ error: 'bo-e' });

    const po = await loadModule('../src/server/payment-orders-actions', [err('po-e')]);
    await expect(po.closePaymentOrderAction('o')).resolves.toEqual({ error: 'po-e' });
  });

  it('ops 族（model-catalog/notifications/tracing/rate-limits/auth twoFactor）', async () => {
    const mc = await loadModule('../src/server/model-catalog-actions', [
      err('mc-e'),
      err('mc-e'),
      err('mc-e'),
      err('mc-e'),
      err('mc-e'),
      err('mc-e'),
    ]);
    const imp = mc.importCatalogAction as unknown as (
      a: Record<string, unknown>,
    ) => Promise<{ error?: string }>;
    await expect(
      imp({ models: [{ externalName: 'm', realModel: 'r', inputPrice: '1', outputPrice: '1' }] }),
    ).resolves.toEqual({ error: 'mc-e' });
    await expect(mc.setFxOverrideAction('1')).resolves.toEqual({ error: 'mc-e' });
    await expect(mc.clearFxOverrideAction()).resolves.toEqual({ error: 'mc-e' });
    await expect(mc.setFxBufferAction('1')).resolves.toEqual({ error: 'mc-e' });
    await expect(mc.refreshFxAction(true)).resolves.toEqual({ error: 'mc-e' });
    await expect(mc.priceHistoryAction('m')).resolves.toEqual({ error: 'mc-e' });

    const no = await loadModule('../src/server/notifications-actions', [
      err('no-e'),
      err('no-e'),
      err('no-e'),
      err('no-e'),
    ]);
    await expect(
      no.createChannelAction({
        name: 'n',
        type: 'email',
        config: { recipients: ['a'] },
        events: [],
      }),
    ).resolves.toEqual({ error: 'no-e' });
    await expect(no.toggleChannelAction(1, 0)).resolves.toEqual({ error: 'no-e' });
    await expect(no.deleteChannelAction(1)).resolves.toEqual({ error: 'no-e' });
    await expect(no.testChannelAction(1)).resolves.toEqual({ error: 'no-e' });

    const tr = await loadModule('../src/server/tracing-actions', [err('tr-e'), err('tr-e')]);
    await expect(tr.fetchTraceDetail('abc')).resolves.toEqual({ error: 'tr-e' });
    await expect(tr.fetchTraceDetailByRequestId('r-1')).resolves.toEqual({ error: 'tr-e' });

    const rl = await loadModule('../src/server/rate-limits-actions', [err('rl-e')]);
    await expect(
      rl.updateRateLimitAction('user', 1, { rpmLimit: 1, tpmLimit: 1 }),
    ).resolves.toEqual({ error: 'rl-e' });

    const au = await loadModule('../src/server/auth-actions', [err('au-e')]);
    await expect(au.setTwoFactorAction(true)).resolves.toEqual({ error: 'au-e' });
  });

  it('admin-list：ApiError 分支（英文 message）', async () => {
    const mod = await loadModule('../src/server/admin-list', [err('al-e')]);
    const res = await mod.fetchAdminList('/v1/users', { pageSize: 20 });
    expect(res.error).toBe('al-e');
  });
});
