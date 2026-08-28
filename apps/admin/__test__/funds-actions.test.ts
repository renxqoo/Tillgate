/**
 * funds 中心 server actions 覆盖：汇率目录（读/覆盖/清除/点差/刷新）与平台币种
 * （读/写一次），以及 settings-actions 的资金参数面（透支地板默认、存量刷默认、
 * 预扣策略、敞口上限、集成列表与送礼读）——wire 调用形状 + {error} 信封语义
 * + 前置校验分支（与 server-actions.test.ts 同装置）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defined } from './defined';
import { installNextStubs, mockFetch, type FetchCall } from './harness';

/** 每用例装置：重装桩 → 动态导入被测模块（vi.doMock 只影响后续 import） */
async function loadModule(path: string, responses: Parameters<typeof mockFetch>[0]) {
  vi.resetModules();
  const { fetchStub, calls } = mockFetch(responses);
  vi.stubGlobal('fetch', fetchStub);
  const stubs = installNextStubs();
  const mod = await import(path);
  return { mod, calls, ...stubs };
}

function last(calls: FetchCall[]): FetchCall {
  return defined(calls.at(-1), 'last fetch call');
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

describe('funds-actions 汇率目录', () => {
  it('getFxStateAction：GET /v1/fx/catalog 透传状态形状；传输层失败 unavailable', async () => {
    const STATE = {
      mode: 'auto',
      baseRate: '7.1',
      effectiveRate: '7.277',
      bufferPct: '2.5',
      source: 'ecb',
      fetchedAt: '2026-08-28T00:00:00Z',
    };
    const { mod, calls } = await loadModule('../src/server/funds-actions', [
      { status: 200, body: STATE },
    ]);
    await expect(mod.getFxStateAction()).resolves.toEqual({ state: STATE });
    expect(last(calls)).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8082/v1/fx/catalog',
    });

    const { mod: m2 } = await loadModule('../src/server/funds-actions', [{ throwError: true }]);
    await expect(m2.getFxStateAction()).resolves.toEqual({ error: 'unavailable' });
  });

  it('setFxOverrideAction：PUT /override 载荷 {rate}；ApiError 透传 message；网络异常 actionFailed', async () => {
    const { mod, calls } = await loadModule('../src/server/funds-actions', [
      { status: 200, body: {} },
    ]);
    await expect(mod.setFxOverrideAction('7.25')).resolves.toEqual({ ok: true });
    expect(last(calls)).toMatchObject({
      method: 'PUT',
      url: 'http://localhost:8082/v1/fx/catalog/override',
      body: { rate: '7.25' },
    });

    const { mod: m2 } = await loadModule('../src/server/funds-actions', [
      { status: 422, body: { error: { code: 'fx.invalid_rate', message: 'rate out of range' } } },
    ]);
    await expect(m2.setFxOverrideAction('0')).resolves.toEqual({ error: 'rate out of range' });

    const { mod: m3 } = await loadModule('../src/server/funds-actions', [{ throwError: true }]);
    await expect(m3.setFxOverrideAction('7.25')).resolves.toEqual({ error: 'actionFailed' });
  });

  it('clearFxOverrideAction：DELETE /override 回 auto；失败翻译', async () => {
    const { mod, calls } = await loadModule('../src/server/funds-actions', [
      { status: 200, body: {} },
    ]);
    await expect(mod.clearFxOverrideAction()).resolves.toEqual({ ok: true });
    expect(last(calls)).toMatchObject({
      method: 'DELETE',
      url: 'http://localhost:8082/v1/fx/catalog/override',
    });

    const { mod: m2 } = await loadModule('../src/server/funds-actions', [
      { status: 403, body: { error: { code: 'x', message: 'no funds:fx' } } },
    ]);
    await expect(m2.clearFxOverrideAction()).resolves.toEqual({ error: 'no funds:fx' });

    const { mod: m3 } = await loadModule('../src/server/funds-actions', [{ throwError: true }]);
    await expect(m3.clearFxOverrideAction()).resolves.toEqual({ error: 'actionFailed' });
  });

  it('setFxBufferAction：点差形状前置校验（垃圾/四位小数/六位整数拒，零 fetch）；合法 PUT；失败翻译', async () => {
    const { mod, calls } = await loadModule('../src/server/funds-actions', []);
    await expect(mod.setFxBufferAction('abc')).resolves.toEqual({ error: 'invalidBuffer' });
    await expect(mod.setFxBufferAction('1.2345')).resolves.toEqual({ error: 'invalidBuffer' });
    await expect(mod.setFxBufferAction('123456')).resolves.toEqual({ error: 'invalidBuffer' });
    expect(calls).toHaveLength(0);

    const { mod: m2, calls: c2 } = await loadModule('../src/server/funds-actions', [
      { status: 200, body: {} },
    ]);
    await expect(m2.setFxBufferAction('-1.5')).resolves.toEqual({ ok: true });
    expect(last(c2)).toMatchObject({
      method: 'PUT',
      url: 'http://localhost:8082/v1/fx/catalog/buffer',
      body: { bufferPct: '-1.5' },
    });

    const { mod: m3 } = await loadModule('../src/server/funds-actions', [
      { status: 500, body: { error: { code: 'x', message: 'buffer boom' } } },
    ]);
    await expect(m3.setFxBufferAction('2')).resolves.toEqual({ error: 'buffer boom' });

    const { mod: m4 } = await loadModule('../src/server/funds-actions', [{ throwError: true }]);
    await expect(m4.setFxBufferAction('2')).resolves.toEqual({ error: 'actionFailed' });
  });

  it('refreshFxAction：POST /refresh 恒为 force；失败翻译', async () => {
    const { mod, calls } = await loadModule('../src/server/funds-actions', [
      { status: 200, body: {} },
    ]);
    await expect(mod.refreshFxAction()).resolves.toEqual({ ok: true });
    expect(last(calls)).toMatchObject({
      method: 'POST',
      url: 'http://localhost:8082/v1/fx/catalog/refresh',
      body: { force: true },
    });

    const { mod: m2 } = await loadModule('../src/server/funds-actions', [{ throwError: true }]);
    await expect(m2.refreshFxAction()).resolves.toEqual({ error: 'actionFailed' });

    const { mod: m3 } = await loadModule('../src/server/funds-actions', [
      { status: 502, body: { error: { code: 'x', message: 'source down' } } },
    ]);
    await expect(m3.refreshFxAction()).resolves.toEqual({ error: 'source down' });
  });
});

describe('funds-actions 平台币种（写一次）', () => {
  it('getPlatformCurrencyAction：读透传；失败 unavailable', async () => {
    const { mod, calls } = await loadModule('../src/server/funds-actions', [
      { status: 200, body: { currency: 'CNY' } },
    ]);
    await expect(mod.getPlatformCurrencyAction()).resolves.toEqual({ currency: 'CNY' });
    expect(last(calls)).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8082/v1/settings/platform-currency',
    });

    const { mod: m2 } = await loadModule('../src/server/funds-actions', [{ throwError: true }]);
    await expect(m2.getPlatformCurrencyAction()).resolves.toEqual({ error: 'unavailable' });
  });

  it('updatePlatformCurrencyAction：仅三字母大写放行（小写/短/长/数字零 fetch）；PUT 载荷；409 透传 message', async () => {
    const { mod, calls } = await loadModule('../src/server/funds-actions', []);
    for (const bad of ['usd', 'CN', 'USDD', 'C4Y', '']) {
      await expect(mod.updatePlatformCurrencyAction(bad)).resolves.toEqual({
        error: 'invalidCurrency',
      });
    }
    expect(calls).toHaveLength(0);

    const { mod: m2, calls: c2 } = await loadModule('../src/server/funds-actions', [
      { status: 200, body: {} },
    ]);
    await expect(m2.updatePlatformCurrencyAction('USD')).resolves.toEqual({ ok: true });
    expect(last(c2)).toMatchObject({
      method: 'PUT',
      url: 'http://localhost:8082/v1/settings/platform-currency',
      body: { currency: 'USD' },
    });

    const { mod: m3 } = await loadModule('../src/server/funds-actions', [
      {
        status: 409,
        body: { error: { code: 'platform_currency_locked', message: 'ledger rows exist' } },
      },
    ]);
    await expect(m3.updatePlatformCurrencyAction('USD')).resolves.toEqual({
      error: 'ledger rows exist',
    });

    const { mod: m4 } = await loadModule('../src/server/funds-actions', [{ throwError: true }]);
    await expect(m4.updatePlatformCurrencyAction('USD')).resolves.toEqual({
      error: 'actionFailed',
    });
  });
});

describe('settings-actions 透支地板默认与存量刷默认', () => {
  it('读：成功透传；失败回落 "0"+unavailable', async () => {
    const { mod, calls } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: { floor: '5' } },
    ]);
    await expect(mod.getDebitFloorDefaultAction()).resolves.toEqual({ floor: '5' });
    expect(last(calls)).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8082/v1/settings/debit-floor-default',
    });

    const { mod: m2 } = await loadModule('../src/server/settings-actions', [{ throwError: true }]);
    await expect(m2.getDebitFloorDefaultAction()).resolves.toEqual({
      floor: '0',
      error: 'unavailable',
    });
  });

  it('写：PUT 形状；ApiError 透传 message；网络异常 saveFailed', async () => {
    const { mod, calls } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: {} },
    ]);
    await expect(mod.updateDebitFloorDefaultAction('2.5')).resolves.toEqual({ ok: true });
    expect(last(calls)).toMatchObject({
      method: 'PUT',
      url: 'http://localhost:8082/v1/settings/debit-floor-default',
      body: { floor: '2.5' },
    });

    const { mod: m2 } = await loadModule('../src/server/settings-actions', [
      { status: 422, body: { error: { code: 'x', message: 'floor too deep' } } },
    ]);
    await expect(m2.updateDebitFloorDefaultAction('1')).resolves.toEqual({
      error: 'floor too deep',
    });

    const { mod: m3 } = await loadModule('../src/server/settings-actions', [{ throwError: true }]);
    await expect(m3.updateDebitFloorDefaultAction('1')).resolves.toEqual({ error: 'saveFailed' });
  });

  it('applyDebitFloorDefaultAction：POST 透传 {applied,skipped}；失败翻译', async () => {
    const { mod, calls } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: { applied: 3, skipped: 1, floor: '2' } },
    ]);
    await expect(mod.applyDebitFloorDefaultAction()).resolves.toEqual({
      ok: true,
      applied: 3,
      skipped: 1,
    });
    expect(last(calls)).toMatchObject({
      method: 'POST',
      url: 'http://localhost:8082/v1/wallets/debit-floor/apply-default',
    });

    const { mod: m2 } = await loadModule('../src/server/settings-actions', [{ throwError: true }]);
    await expect(m2.applyDebitFloorDefaultAction()).resolves.toEqual({ error: 'actionFailed' });
  });
});

describe('settings-actions 预扣策略与敞口上限', () => {
  it('预扣策略读：成功透传 policy；失败回落 null+unavailable', async () => {
    const POLICY = { mode: 'fixed' as const, amount: '0.01' };
    const { mod, calls } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: { policy: POLICY } },
    ]);
    await expect(mod.getBillingReservationAction()).resolves.toEqual({ policy: POLICY });
    expect(last(calls)).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8082/v1/settings/billing-reservation',
    });

    const { mod: m2 } = await loadModule('../src/server/settings-actions', [{ throwError: true }]);
    await expect(m2.getBillingReservationAction()).resolves.toEqual({
      policy: null,
      error: 'unavailable',
    });
  });

  it('预扣策略写：fixed 金额形状与零值拒绝（零 fetch）；full 免金额直传；失败翻译', async () => {
    const { mod, calls } = await loadModule('../src/server/settings-actions', []);
    await expect(
      mod.updateBillingReservationAction({ mode: 'fixed', amount: 'abc' }),
    ).resolves.toEqual({ error: 'invalidAmount' });
    await expect(
      mod.updateBillingReservationAction({ mode: 'fixed', amount: '0' }),
    ).resolves.toEqual({ error: 'invalidAmount' });
    await expect(
      mod.updateBillingReservationAction({ mode: 'fixed', amount: '0.00' }),
    ).resolves.toEqual({ error: 'invalidAmount' });
    expect(calls).toHaveLength(0);

    const { mod: m2, calls: c2 } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: {} },
    ]);
    await expect(
      m2.updateBillingReservationAction({ mode: 'fixed', amount: '0.01' }),
    ).resolves.toEqual({ ok: true });
    expect(last(c2)).toMatchObject({
      method: 'PUT',
      url: 'http://localhost:8082/v1/settings/billing-reservation',
      body: { mode: 'fixed', amount: '0.01' },
    });

    const { mod: m3, calls: c3 } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: {} },
    ]);
    await expect(m3.updateBillingReservationAction({ mode: 'full' })).resolves.toEqual({
      ok: true,
    });
    expect(last(c3)).toMatchObject({
      body: { mode: 'full' },
    });

    const { mod: m4 } = await loadModule('../src/server/settings-actions', [
      { status: 422, body: { error: { code: 'x', message: 'amount too small' } } },
    ]);
    await expect(
      m4.updateBillingReservationAction({ mode: 'fixed', amount: '0.01' }),
    ).resolves.toEqual({ error: 'amount too small' });
  });

  it('敞口上限读：成功透传；失败回落 "1000"+unavailable', async () => {
    const { mod, calls } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: { limit: '2500' } },
    ]);
    await expect(mod.getBillingReservationLimitAction()).resolves.toEqual({ limit: '2500' });
    expect(last(calls)).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8082/v1/settings/billing-reservation-limit',
    });

    const { mod: m2 } = await loadModule('../src/server/settings-actions', [{ throwError: true }]);
    await expect(m2.getBillingReservationLimitAction()).resolves.toEqual({
      limit: '1000',
      error: 'unavailable',
    });
  });

  it('敞口上限写：非正/垃圾拒绝（零 fetch）；合法 PUT；失败翻译', async () => {
    const { mod, calls } = await loadModule('../src/server/settings-actions', []);
    await expect(mod.updateBillingReservationLimitAction('-5')).resolves.toEqual({
      error: 'invalidAmount',
    });
    await expect(mod.updateBillingReservationLimitAction('abc')).resolves.toEqual({
      error: 'invalidAmount',
    });
    await expect(mod.updateBillingReservationLimitAction('0')).resolves.toEqual({
      error: 'invalidAmount',
    });
    expect(calls).toHaveLength(0);

    const { mod: m2, calls: c2 } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: {} },
    ]);
    await expect(m2.updateBillingReservationLimitAction('2000.5')).resolves.toEqual({ ok: true });
    expect(last(c2)).toMatchObject({
      method: 'PUT',
      url: 'http://localhost:8082/v1/settings/billing-reservation-limit',
      body: { limit: '2000.5' },
    });

    const { mod: m3 } = await loadModule('../src/server/settings-actions', [{ throwError: true }]);
    await expect(m3.updateBillingReservationLimitAction('1')).resolves.toEqual({
      error: 'saveFailed',
    });
  });
});

describe('settings-actions 集成列表与送礼读（降级信封）', () => {
  it('getIntegrationSettingsAction：成功透传 {integrations}；失败空列表+unavailable', async () => {
    const INTEGRATIONS = [
      {
        key: 'smtp',
        enabled: true,
        configured: true,
        config: { host: 'smtp.x' },
        secretsSet: ['password'],
        rotatedAt: null,
        updatedAt: '2026-08-01T00:00:00Z',
        updatedByAdminId: 1,
      },
    ];
    const { mod, calls } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: { integrations: INTEGRATIONS } },
    ]);
    await expect(mod.getIntegrationSettingsAction()).resolves.toEqual({
      integrations: INTEGRATIONS,
    });
    expect(last(calls)).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8082/v1/settings/integrations',
    });

    const { mod: m2 } = await loadModule('../src/server/settings-actions', [{ throwError: true }]);
    await expect(m2.getIntegrationSettingsAction()).resolves.toEqual({
      integrations: [],
      error: 'unavailable',
    });
  });

  it('getMarketingSignupGiftAction：有值透传；缺席回落 "0"；失败 null', async () => {
    const { mod, calls } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: { signupGiftAmount: '1.5' } },
    ]);
    await expect(mod.getMarketingSignupGiftAction()).resolves.toEqual({ signupGiftAmount: '1.5' });
    expect(last(calls)).toMatchObject({
      method: 'GET',
      url: 'http://localhost:8082/v1/marketing/settings',
    });

    const { mod: m2 } = await loadModule('../src/server/settings-actions', [
      { status: 200, body: {} },
    ]);
    await expect(m2.getMarketingSignupGiftAction()).resolves.toEqual({ signupGiftAmount: '0' });

    const { mod: m3 } = await loadModule('../src/server/settings-actions', [{ throwError: true }]);
    await expect(m3.getMarketingSignupGiftAction()).resolves.toEqual({ signupGiftAmount: null });
  });
});
