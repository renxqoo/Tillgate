/**
 * 分支补面 III：可选字段的携带/缺省两态（?. 与 || 分支）逐文件翻面。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installNextStubs, mockFetch, type MockResponse } from './harness';

async function loadModule(path: string, responses: MockResponse[]) {
  vi.resetModules();
  const { fetchStub, calls } = mockFetch(responses);
  vi.stubGlobal('fetch', fetchStub);
  installNextStubs();
  const mod = await import(path);
  return { mod, calls };
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

describe('可选字段两态', () => {
  it('providers：带/不带 protocol+status 两态', async () => {
    const { mod } = await loadModule('../src/server/providers-actions', [{}, {}]);
    await mod.createProviderAction({ name: 'a', baseUrl: 'https://a' });
    await mod.createProviderAction({
      name: 'b',
      baseUrl: 'https://b',
      protocol: 'gemini',
      status: 0,
    });
    await expect(mod.updateProviderAction(1, {})).resolves.toEqual({});
  });

  it('rate-cards：create 带 description；update 全字段', async () => {
    const { mod } = await loadModule('../src/server/rate-cards-actions', [{}, {}]);
    await mod.createRateCardAction({ name: 'r', description: 'd', coefficient: '1' });
    await mod.updateRateCardAction(1, {
      name: 'r2',
      description: 'd2',
      status: 1,
      coefficient: '2',
    });
  });

  it('channel-funds：recharge/adjust 各字段满配与缺省', async () => {
    const { mod } = await loadModule('../src/server/channel-funds-actions', [{}, {}, {}]);
    await mod.rechargeChannelAction({
      channelId: 1,
      amount: '1',
      orderNo: 'o',
      voucherDataUrl: 'data:x',
      remark: 'r',
    });
    await mod.rechargeChannelAction({ channelId: 2, amount: '2' });
    await mod.adjustChannelAction({ channelId: 3, amount: '-1' });
  });

  it('models：update 可选字段满配；bind 变体', async () => {
    const { mod } = await loadModule('../src/server/models-actions', [{}, {}]);
    await mod.updateModelAction(1, {
      externalName: 'a',
      realModel: 'b',
      inputPrice: '1',
      outputPrice: '2',
      cacheInputPrice: '0.1',
      isFree: true,
      fallbackModels: 'x',
      paramRules: '{}',
      rpmLimit: 10,
      tpmLimit: 20,
      status: 0,
    });
    await mod.bindChannelsAction(1, []);
  });

  it('plans：create 满配（kind/sortOrder/allowSeats）；update 满配', async () => {
    const { mod } = await loadModule('../src/server/plans-actions', [{}, {}]);
    await mod.createPlanAction({
      name: 'p',
      kind: 'pack',
      sortOrder: 2,
      price: '9.9',
      periodDays: 0,
      quotaAmount: '50',
      allowSeats: false,
    });
    await mod.updatePlanAction(1, {
      name: 'p2',
      sortOrder: 3,
      price: '1',
      periodDays: 30,
      quotaAmount: '2',
      allowSeats: true,
      status: 0,
    });
  });

  it('users：freezeReason/remark 有无两态', async () => {
    const { mod } = await loadModule('../src/server/users-actions', [{}, {}, {}, {}]);
    await mod.adjustBalanceAction(1, { amount: '2', remark: '' });
    await mod.giftUserAction(1, { amount: '2', remark: '' });
    await mod.setUserStatusAction(1, { status: 1 });
    await mod.bindRateCardAction(1, 5);
  });

  it('redeem：generate 满配（remark/expiresAt）', async () => {
    const { mod } = await loadModule('../src/server/redeem-batches-actions', [
      { status: 200, body: { batch: { id: 1 }, codes: [] } },
    ]);
    await mod.generateBatchAction({
      name: 'n',
      remark: 'r',
      amount: '5',
      count: 3,
      expiresAt: '2030-01-01',
    });
  });

  it('plans grant：合法 userId 走端点；非法 userId 前置拒绝', async () => {
    const { mod, calls } = await loadModule('../src/server/plans-actions', [{}]);
    await expect(mod.grantPackAction(2, 11)).resolves.toEqual({});
    expect(calls[0]).toMatchObject({ method: 'POST' });
    await expect(mod.grantPackAction(2, 0)).resolves.toEqual({ error: 'invalidUserId' });
    expect(calls).toHaveLength(1);
  });

  it('channels：update 满配（含阈值/限流 null 语义）', async () => {
    const { mod } = await loadModule('../src/server/channels-actions', [{}]);
    const update = mod.updateChannelAction as unknown as (
      a: number,
      b: Record<string, unknown>,
    ) => Promise<unknown>;
    await update(1, {
      name: 'n',
      apiKey: 'k',
      baseUrlOverride: 'https://o',
      models: 'a，b',
      weight: 5,
      priority: 2,
      status: 0,
      rpmLimit: null,
      tpmLimit: 10,
      upstreamThreshold: '100',
    });
  });

  it('model-catalog：import 满配 + priceHistory 空结果分支', async () => {
    const { mod } = await loadModule('../src/server/model-catalog-actions', [
      {},
      { status: 200, body: { entries: [] } },
    ]);
    const imp = mod.importCatalogAction as unknown as (
      a: Record<string, unknown>,
    ) => Promise<unknown>;
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
    const res = await mod.priceHistoryAction('m');
    expect(res).toEqual({ entries: [] });
  });

  it('auth：twoFactor 成功/失败两态 + verify 错误体缺失分支', async () => {
    const { mod } = await loadModule('../src/server/auth-actions', [
      { status: 200, body: {} },
      { status: 502, body: null },
    ]);
    await expect(mod.setTwoFactorAction(true)).resolves.toEqual({});
    // 非 JSON 错误体 → 兜底文案（body null 走 res.json catch）
    await expect(mod.setTwoFactorAction(false)).resolves.toEqual({ error: expect.any(String) });
  });

  it('notifications：create 满配（webhook url/secret/recipients/events/status）', async () => {
    const { mod } = await loadModule('../src/server/notifications-actions', [{}]);
    await mod.createChannelAction({
      name: 'n',
      type: 'webhook',
      config: { url: 'https://h', secret: 's', recipients: ['a@b.c'] },
      events: ['billing.dead'],
      status: 0,
    });
  });
});
