/**
 * 分支补面：网络异常（非 ApiError）降级、语言文案分支、DEV_FAKE_ME、纯工具。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installNextStubs, mockCookieJar, mockFetch } from './harness';

async function loadModule(path: string, responses: Array<Record<string, unknown>>) {
  vi.resetModules();
  const { fetchStub, calls } = mockFetch(responses as never);
  vi.stubGlobal('fetch', fetchStub);
  const stubs = installNextStubs();
  const mod = await import(path);
  return { mod, calls, ...stubs };
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

describe('网络异常分支（fetch reject → 通用失败文案，不抛）', () => {
  it('providers/channels/models/plans/rate-cards/redeem/notifications/subscriptions', async () => {
    const boom = [{ throwError: true }];
    const p1 = await loadModule('../src/server/providers-actions', boom);
    await expect(p1.mod.createProviderAction({ name: 'p', baseUrl: 'https://x' })).resolves.toEqual(
      { error: 'createFailed' },
    );

    const p2 = await loadModule('../src/server/channels-actions', [boom[0]!, boom[0]!]);
    await expect(p2.mod.deleteChannelAction(1)).resolves.toEqual({ error: expect.any(String) });
    const create = p2.mod.createChannelAction as unknown as (
      a: Record<string, unknown>,
    ) => Promise<{ error?: string }>;
    await expect(create({ name: 'c', apiKey: 'k' })).resolves.toEqual({ error: 'createFailed' });

    const p3 = await loadModule('../src/server/models-actions', boom);
    await expect(
      p3.mod.createModelAction({
        externalName: 'a',
        realModel: 'b',
        inputPrice: '1',
        outputPrice: '1',
      }),
    ).resolves.toEqual({ error: 'createFailed' });

    const p4 = await loadModule('../src/server/plans-actions', boom);
    await expect(p4.mod.deletePlanAction(1)).resolves.toEqual({ error: expect.any(String) });

    const p5 = await loadModule('../src/server/rate-cards-actions', boom);
    await expect(p5.mod.deleteRateCardAction(1)).resolves.toEqual({ error: expect.any(String) });

    const p6 = await loadModule('../src/server/redeem-batches-actions', boom);
    await expect(p6.mod.revokeCodeAction(1)).resolves.toEqual({ error: expect.any(String) });

    const p7 = await loadModule('../src/server/notifications-actions', [
      boom[0]!,
      boom[0]!,
      boom[0]!,
      boom[0]!,
    ]);
    await expect(p7.mod.deleteChannelAction(1)).resolves.toEqual({ error: expect.any(String) });
    await expect(p7.mod.testChannelAction(1)).resolves.toEqual({ error: expect.any(String) });
    await expect(p7.mod.toggleChannelAction(1, 0)).resolves.toEqual({ error: expect.any(String) });
    await expect(
      p7.mod.createChannelAction({ name: 'n', type: 'webhook', config: {}, events: [] }),
    ).resolves.toEqual({ error: expect.any(String) });

    const p8 = await loadModule('../src/server/subscriptions-actions', [
      boom[0]!,
      boom[0]!,
      boom[0]!,
    ]);
    await expect(p8.mod.renewSubscriptionAction(1)).resolves.toEqual({ error: expect.any(String) });
    await expect(p8.mod.cancelSubscriptionAction(1)).resolves.toEqual({
      error: expect.any(String),
    });
    await expect(
      p8.mod.changeSubscriptionAction(1, { targetPlanId: 1, quantity: 1 }),
    ).resolves.toEqual({ error: expect.any(String) });

    const p9 = await loadModule('../src/server/referrals-actions', boom);
    // referrals/marketing 族语义：失败抛错（useActionResult 捕获呈现），不吞
    await expect(p9.mod.setRelationStatusAction(1, 1)).rejects.toThrow('network down');

    const p10 = await loadModule('../src/server/payment-orders-actions', boom);
    await expect(p10.mod.closePaymentOrderAction('o1')).resolves.toEqual({
      error: expect.any(String),
    });

    const p11 = await loadModule('../src/server/billing-operations-actions', [boom[0]!, boom[0]!]);
    await expect(
      p11.mod.retryDeadBillingRequest({ requestId: 'r', expectedRevision: 1, reason: 'x' }),
    ).resolves.toEqual({ error: expect.any(String) });
    await expect(
      p11.mod.abandonDeadBillingRequest({ requestId: 'r', expectedRevision: 1, reason: 'x' }),
    ).resolves.toEqual({ error: expect.any(String) });

    const p12 = await loadModule(
      '../src/server/model-catalog-actions',
      Array.from({ length: 5 }, () => boom[0]!),
    );
    await expect(p12.mod.setFxOverrideAction('7')).resolves.toEqual({ error: expect.any(String) });
    await expect(p12.mod.clearFxOverrideAction()).resolves.toEqual({ error: expect.any(String) });
    await expect(p12.mod.setFxBufferAction('2')).resolves.toEqual({ error: expect.any(String) });
    await expect(p12.mod.refreshFxAction(false)).resolves.toEqual({ error: expect.any(String) });
    await expect(p12.mod.priceHistoryAction('m')).resolves.toEqual({ error: expect.any(String) });

    const p13 = await loadModule('../src/server/tracing-actions', [boom[0]!, boom[0]!]);
    await expect(p13.mod.fetchTraceDetail('abc')).resolves.toEqual({ error: expect.any(String) });
    await expect(p13.mod.fetchTraceDetailByRequestId('req-1')).resolves.toEqual({
      error: expect.any(String),
    });
  });
});

describe('admin-list 语言分支', () => {
  it('非 ApiError 失败时按界面语言给中文文案（zh 请求上下文）', async () => {
    vi.resetModules();
    const { fetchStub } = mockFetch([{ throwError: true }]);
    vi.stubGlobal('fetch', fetchStub);
    vi.doMock('next/headers', () => ({
      cookies: async () => mockCookieJar().jar,
      headers: async () => new Map([['accept-language', 'zh-CN,zh;q=0.9']]),
    }));
    vi.doMock('next/cache', () => ({ revalidatePath: () => undefined }));
    vi.doMock('next/navigation', () => ({
      redirect: (p: string) => {
        throw Object.assign(new Error(`redirect:${p}`), { __redirect: p });
      },
    }));
    vi.doMock('next-intl/server', () => ({
      getTranslations: async () => ((k: string) => k) as never,
      getLocale: async () => 'zh',
    }));
    const mod = await import('../src/server/admin-list');
    const res = await mod.fetchAdminList('/v1/users', { pageSize: 20 });
    expect(res.error).toBe('加载失败');
  });
});

describe('get-admin DEV_FAKE_ME', () => {
  it('dev 后门返回伪造管理员（生产不生效）', async () => {
    process.env.DEV_FAKE_ME = '1';
    vi.stubEnv('NODE_ENV', 'test');
    const { mod } = await loadModule('../src/server/get-admin', []);
    const me = await mod.requireAdmin();
    expect(me.id).toBe(99);
    delete process.env.DEV_FAKE_ME;
    vi.unstubAllEnvs();
  });
});

describe('auth-actions 网络不可达分支', () => {
  it('登录 fetch 抛错 → serviceUnavailable 文案', async () => {
    vi.resetModules();
    const { fetchStub } = mockFetch([{ throwError: true }, { throwError: true }]);
    vi.stubGlobal('fetch', fetchStub);
    installNextStubs();
    const mod = await import('../src/server/auth-actions');
    const fd = new FormData();
    fd.set('email', 'a@b.c');
    fd.set('password', 'pw');
    await expect(mod.loginAction(fd)).resolves.toEqual({ error: 'serviceUnavailable' });
    await expect(mod.verifyLoginAction('ch', '123456')).resolves.toEqual({
      error: 'serviceUnavailable',
    });
  });
});

describe('lib/utils（cn/getInitials/formatCurrency）', () => {
  it('cn 合并 tailwind 类名；getInitials 取词首字母', async () => {
    const { cn, getInitials, formatCurrency } = await import('../src/lib/utils');
    expect(cn('p-1', 'p-2')).toBe('p-2');
    expect(getInitials('Ada Lovelace')).toBe('AL');
    expect(getInitials('')).toBe('?');
    expect(formatCurrency(1.5)).toBe('$1.50');
  });
});
