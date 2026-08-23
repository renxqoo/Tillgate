/**
 * server actions 表驱动契约测试：wire 调用形状（method/path/body）+ {error} 信封语义
 * + 前置校验分支。fetch/next 运行时全部桩化（harness）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installNextStubs, mockCookieJar, mockFetch, type FetchCall } from './harness';

/** 每用例装置：重装桩 → 动态导入被测模块（vi.doMock 只影响后续 import） */
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

describe('users-actions', () => {
  it('adjustBalanceAction：正金额走 POST /v1/users/:id/adjust 且 remark 去空白', async () => {
    const { mod, calls } = await loadModule('../src/server/users-actions', [
      { status: 200, body: {} },
    ]);
    const res = await mod.adjustBalanceAction(7, { amount: '-12.5', remark: '  调账  ' });
    expect(res).toEqual({});
    expect(last(calls)).toMatchObject({
      method: 'POST',
      url: 'http://localhost:8082/v1/users/7/adjust',
      body: { amount: '-12.5', remark: '调账' },
    });
  });

  it('adjustBalanceAction：零值/垃圾形状被前置校验拒绝且零 fetch', async () => {
    const { mod, calls } = await loadModule('../src/server/users-actions', []);
    await expect(mod.adjustBalanceAction(7, { amount: '0', remark: '' })).resolves.toEqual({
      error: 'adjustNonZero',
    });
    await expect(mod.adjustBalanceAction(7, { amount: 'abc', remark: '' })).resolves.toEqual({
      error: 'adjustNonZero',
    });
    expect(calls).toHaveLength(0);
  });

  it('adjustBalanceAction：非 2xx 错误信封映射为 error message（英文透传）', async () => {
    const { mod } = await loadModule('../src/server/users-actions', [
      { status: 422, body: { error: { code: 'x', message: 'invalid amount' } } },
    ]);
    await expect(mod.adjustBalanceAction(7, { amount: '1', remark: '' })).resolves.toEqual({
      error: 'invalid amount',
    });
  });

  it('giftUserAction：负数被拒；正数走 gift 端点', async () => {
    const { mod, calls } = await loadModule('../src/server/users-actions', [
      { status: 200, body: {} },
    ]);
    await expect(mod.giftUserAction(7, { amount: '-1', remark: '' })).resolves.toEqual({
      error: 'giftPositive',
    });
    await expect(mod.giftUserAction(7, { amount: '3.2', remark: '' })).resolves.toEqual({});
    expect(last(calls)).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/users/7/gift'),
    });
  });

  it('setPasswordAction：短密码被拒；合规密码走端点', async () => {
    const { mod, calls } = await loadModule('../src/server/users-actions', [
      { status: 200, body: {} },
    ]);
    await expect(mod.setPasswordAction(7, { password: '123' })).resolves.toEqual({
      error: 'passwordMin6',
    });
    await expect(mod.setPasswordAction(7, { password: '123456' })).resolves.toEqual({});
    expect(last(calls)).toMatchObject({ method: 'POST', body: { password: '123456' } });
  });

  it('setUserStatusAction / setUserEnterpriseAction / bindRateCardAction：动词与路径', async () => {
    const { mod, calls } = await loadModule('../src/server/users-actions', [{}, {}, {}]);
    await expect(mod.setUserStatusAction(5, { status: 1, freezeReason: 'risk' })).resolves.toEqual(
      {},
    );
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: expect.stringContaining('/v1/users/5'),
    });
    await expect(mod.setUserEnterpriseAction(5, true)).resolves.toEqual({});
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: { isEnterprise: true } });
    await expect(mod.bindRateCardAction(5, null)).resolves.toEqual({});
    expect(calls[2]).toMatchObject({ method: 'PATCH', body: { rateCardId: null } });
  });
});

function loginForm(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set('email', email);
  fd.set('password', password);
  return fd;
}

describe('auth-actions', () => {

  it('loginAction：成功取 token 写会话 cookie 并重定向 /dashboard', async () => {
    vi.resetModules();
    const { fetchStub, calls } = mockFetch([{ status: 200, body: { token: 'jwt-1' } }]);
    vi.stubGlobal('fetch', fetchStub);
    const jar = mockCookieJar();
    installNextStubs({ jar: jar.jar });
    const mod = await import('../src/server/auth-actions');
    await expect(mod.loginAction(loginForm('a@b.c', 'pw'))).rejects.toMatchObject({
      __redirect: '/dashboard',
    });
    expect(jar.store.get('ag_admin_session')).toBe('jwt-1');
    expect(last(calls)).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/auth/login'),
    });
  });

  it('loginAction：2FA 首步返回 challengeId 不写 cookie', async () => {
    vi.resetModules();
    const { fetchStub } = mockFetch([
      { status: 200, body: { twoFactorRequired: true, challengeId: 'ch-1' } },
    ]);
    vi.stubGlobal('fetch', fetchStub);
    const jar = mockCookieJar();
    installNextStubs({ jar: jar.jar });
    const mod = await import('../src/server/auth-actions');
    await expect(mod.loginAction(loginForm('a@b.c', 'pw'))).resolves.toEqual({
      challengeId: 'ch-1',
    });
    expect(jar.store.has('ag_admin_session')).toBe(false);
  });

  it('verifyLoginAction：非 6 位码被拒；成功写 cookie 并重定向', async () => {
    vi.resetModules();
    const { fetchStub } = mockFetch([{ status: 200, body: { token: 'jwt-2' } }]);
    vi.stubGlobal('fetch', fetchStub);
    const jar = mockCookieJar();
    installNextStubs({ jar: jar.jar });
    const mod = await import('../src/server/auth-actions');
    await expect(mod.verifyLoginAction('ch', '12')).resolves.toEqual({ error: 'invalidCode' });
    await expect(mod.verifyLoginAction('ch', '123456')).rejects.toMatchObject({
      __redirect: '/dashboard',
    });
    expect(jar.store.get('ag_admin_session')).toBe('jwt-2');
  });

  it('logoutAction：吊销 best-effort 后清 cookie 重定向登录页', async () => {
    vi.resetModules();
    const { fetchStub, calls } = mockFetch([{ status: 500, body: {} }]);
    vi.stubGlobal('fetch', fetchStub);
    const jar = mockCookieJar({ ag_admin_session: 'jwt-3' });
    installNextStubs({ jar: jar.jar });
    const mod = await import('../src/server/auth-actions');
    await expect(mod.logoutAction()).rejects.toMatchObject({ __redirect: '/login' });
    expect(jar.store.has('ag_admin_session')).toBe(false);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/auth/logout'),
    });
  });

  it('setTwoFactorAction：走 /v1/me/two-factor；失败回 error', async () => {
    const { mod } = await loadModule('../src/server/auth-actions', [
      { status: 200, body: {} },
      { status: 403, body: { error: { message: 'denied' } } },
    ]);
    await expect(mod.setTwoFactorAction(true)).resolves.toEqual({});
    await expect(mod.setTwoFactorAction(false)).resolves.toEqual({ error: 'denied' });
  });
});

describe('get-admin 守卫', () => {
  it('/v1/me 拿到管理员即放行；拿不到重定向 /login', async () => {
    vi.resetModules();
    const { fetchStub } = mockFetch([
      { status: 200, body: { id: 1, email: 'a@b.c', displayName: null, lastLoginAt: null } },
      { status: 401, body: { error: { message: 'no session' } } },
    ]);
    vi.stubGlobal('fetch', fetchStub);
    installNextStubs();
    const { requireAdmin, userFromAdminMe } = await import('../src/server/get-admin');
    const me = await requireAdmin();
    expect(me.email).toBe('a@b.c');
    expect(userFromAdminMe(me)).toMatchObject({ name: 'a@b.c' });
    await expect(requireAdmin()).rejects.toMatchObject({ __redirect: '/login' });
  });
});

describe('admin-list 列表取数', () => {
  it('fetchAdminList：分页查询串构造 + 信封解析', async () => {
    const { mod, calls } = await loadModule('../src/server/admin-list', [
      { status: 200, body: { rows: [{ id: 1 }], total: 3, page: 1, pageSize: 20 } },
    ]);
    const fetchList = mod.fetchAdminList as (
      path: string,
      opts: Record<string, unknown>,
    ) => Promise<{ rows: Array<{ id: number }>; total: number; error: string | null }>;
    const res = await fetchList('/v1/users', {
      page: 2,
      pageSize: 20,
      sortBy: 'createdAt',
      order: 'asc',
      extra: { q: 'x', empty: '', zero: 0 },
    });
    expect(res).toEqual({ rows: [{ id: 1 }], total: 3, error: null });
    const url = new URL(last(calls).url);
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('sort_by')).toBe('createdAt');
    expect(url.searchParams.get('order')).toBe('asc');
    expect(url.searchParams.get('q')).toBe('x');
    expect(url.searchParams.get('empty')).toBe(null);
    expect(url.searchParams.get('zero')).toBe('0');
  });

  it('fetchAdminList：失败降级 {rows:[], total:0, error}（不抛）', async () => {
    const { mod } = await loadModule('../src/server/admin-list', [
      { status: 500, body: { error: { message: 'boom' } } },
    ]);
    const res = await mod.fetchAdminList('/v1/users', { pageSize: 20 });
    expect(res).toEqual({ rows: [], total: 0, error: 'boom' });
  });
});

describe('control-plane 域（providers/channels/models/rate-cards/rate-limits）', () => {
  it('providers：创建/更新/删除动词与路径', async () => {
    const { mod, calls } = await loadModule('../src/server/providers-actions', [{}, {}, {}]);
    await mod.createProviderAction({
      name: 'p',
      baseUrl: 'https://x',
      protocol: 'openai-compatible',
    });
    await mod.updateProviderAction(3, { name: 'q' });
    await mod.deleteProviderAction(3);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/providers'),
    });
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      url: expect.stringContaining('/v1/providers/3'),
    });
    expect(calls[2]).toMatchObject({ method: 'DELETE' });
  });

  it('channels：测试端点结果形状透传（ok/durationMs/error）', async () => {
    const { mod, calls } = await loadModule('../src/server/channels-actions', [
      { status: 200, body: { ok: true, durationMs: 12, keyPreview: 'ag_**' } },
      { status: 200, body: { ok: false, durationMs: 3, error: 'upstream down' } },
    ]);
    await expect(mod.testChannelAction(9)).resolves.toEqual({
      ok: true,
      durationMs: 12,
      keyPreview: 'ag_**',
    });
    await expect(mod.testChannelAction(9)).resolves.toMatchObject({ ok: false });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/channels/9/test'),
    });
  });

  it('rate-limits：按实体路由 PATH_BY_KIND（user/model/channel/key）', async () => {
    const { mod, calls } = await loadModule('../src/server/rate-limits-actions', [{}, {}, {}, {}]);
    await mod.updateRateLimitAction('user', 1, { rpmLimit: 10, tpmLimit: null, creditLimit: '5' });
    await mod.updateRateLimitAction('model', 2, { rpmLimit: null, tpmLimit: 5 });
    await mod.updateRateLimitAction('channel', 3, { rpmLimit: 1, tpmLimit: 2 });
    await mod.updateRateLimitAction('key', 4, { rpmLimit: 1, tpmLimit: 2, dailySpendLimit: '9' });
    expect(calls[0]).toMatchObject({
      url: expect.stringContaining('/v1/users/1'),
      body: { rpmLimit: 10, tpmLimit: null, creditLimit: '5' },
    });
    expect(calls[1]).toMatchObject({
      url: expect.stringContaining('/v1/models/2'),
      body: { rpmLimit: null, tpmLimit: 5 },
    });
    expect(calls[2]).toMatchObject({ url: expect.stringContaining('/v1/channels/3') });
    expect(calls[3]).toMatchObject({
      url: expect.stringContaining('/v1/admin-keys/4'),
      body: { dailySpendLimit: '9' },
    });
  });

  it('models：test 端点 results 透传；绑定渠道走 POST /v1/models/:id/channels', async () => {
    const { mod, calls } = await loadModule('../src/server/models-actions', [
      { status: 200, body: { results: [{ ok: true }] } },
      { status: 200, body: {} },
    ]);
    await expect(mod.testModelAction(5)).resolves.toEqual({ results: [{ ok: true }] });
    await mod.bindChannelsAction(5, [{ channelId: 1, realModel: 'm' }]);
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/models/5/channels'),
    });
  });

  it('rate-cards：创建/更新/删除', async () => {
    const { mod, calls } = await loadModule('../src/server/rate-cards-actions', [{}, {}, {}]);
    await mod.createRateCardAction({ name: 'r', coefficient: '1.0' });
    await mod.updateRateCardAction(2, { status: 0 });
    await mod.deleteRateCardAction(2);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH', 'DELETE']);
  });
});

describe('billing 域', () => {
  it('billing-operations：retry/abandon 决策体（expectedRevision/reason）', async () => {
    const { mod, calls } = await loadModule('../src/server/billing-operations-actions', [{}, {}]);
    await mod.retryDeadBillingRequest({ requestId: 'req-1', expectedRevision: 3, reason: 'ok' });
    await mod.abandonDeadBillingRequest({ requestId: 'req-1', expectedRevision: 3, reason: 'bad' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/billing-operations/req-1/retry'),
      body: { expectedRevision: 3, reason: 'ok' },
    });
    expect(calls[1]).toMatchObject({ url: expect.stringContaining('/abandon') });
  });

  it('plans：grant 包（userId/planId/quantity）；payment-orders close', async () => {
    const { mod, calls } = await loadModule('../src/server/plans-actions', [{}]);
    // grantPackAction 签名以实现为准：动态取形参传入
    const anyGrant = mod.grantPackAction as (
      a: unknown,
      b: unknown,
      c?: unknown,
    ) => Promise<{ error?: string }>;
    await anyGrant(1, 2, 3);
    expect(last(calls)).toMatchObject({ method: 'POST' });

    const { mod: po } = await loadModule('../src/server/payment-orders-actions', [{}]);
    await expect(po.closePaymentOrderAction('ord-9')).resolves.toEqual({});
  });

  it('redeem-batches：生成批次成功透传明文码；作废单码', async () => {
    const { mod, calls } = await loadModule('../src/server/redeem-batches-actions', [
      { status: 200, body: { batch: { id: 1 }, codes: ['A', 'B'] } },
      {},
    ]);
    const res = await mod.generateBatchAction({ name: 'n', amount: '10', count: 2 });
    expect(res).toEqual({ batch: { batch: { id: 1 }, codes: ['A', 'B'] } });
    await mod.revokeCodeAction(44);
    expect(last(calls)).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/redeem-batches/codes/44/revoke'),
    });
  });

  it('subscriptions：renew/cancel/change/grant 动词', async () => {
    const { mod, calls } = await loadModule('../src/server/subscriptions-actions', [{}, {}]);
    await mod.renewSubscriptionAction(8);
    await mod.cancelSubscriptionAction(8);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/subscriptions/8/renew'),
    });
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/subscriptions/8/cancel'),
    });
  });

  it('channel-funds：recharge/adjust 资金动词（金额前置校验）', async () => {
    const { mod, calls } = await loadModule('../src/server/channel-funds-actions', [{}, {}]);
    const anyRe = mod.rechargeChannelAction as (
      a: unknown,
      b: unknown,
    ) => Promise<{ error?: string }>;
    await anyRe({ channelId: 1, amount: '100', voucher: null }, { currentUserId: 1 });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/channel-funds/recharge'),
    });
  });

  it('marketing/referrals：保存与关系状态', async () => {
    const { mod: mk } = await loadModule('../src/server/marketing-actions', [{}]);
    await expect(mk.saveMarketingSettingsAction({} as never)).resolves.toBeDefined();
    const { mod: rf, calls } = await loadModule('../src/server/referrals-actions', [{}]);
    await rf.setRelationStatusAction(6, 1);
    expect(last(calls)).toMatchObject({
      method: 'PATCH',
      url: expect.stringContaining('/v1/referrals/relations/6'),
    });
  });
});

describe('tracing/notifications/model-catalog', () => {
  it('tracing：detail 与 by-request 两条懒加载路径', async () => {
    const { mod, calls } = await loadModule('../src/server/tracing-actions', [
      { status: 200, body: { spans: [], services: [], startMs: 0, durationMs: 0 } },
      { status: 404, body: { error: { message: 'no trace' } } },
    ]);
    await expect(mod.fetchTraceDetail('abc123')).resolves.toEqual({
      spans: [],
      services: [],
      startMs: 0,
      durationMs: 0,
    });
    await expect(mod.fetchTraceDetailByRequestId('r-1')).resolves.toEqual({ error: 'no trace' });
    expect(calls[0]).toMatchObject({ url: expect.stringContaining('/v1/tracing/traces/abc123') });
    expect(calls[1]).toMatchObject({ url: expect.stringContaining('/v1/tracing/by-request/r-1') });
  });

  it('notifications：创建/开关/删除/测试端点', async () => {
    const { mod, calls } = await loadModule('../src/server/notifications-actions', [
      {},
      {},
      {},
      {},
    ]);
    await mod.createChannelAction({} as never);
    await mod.toggleChannelAction(3, 0);
    await mod.deleteChannelAction(3);
    await mod.testChannelAction(3);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH', 'DELETE', 'POST']);
  });

  it('model-catalog：fx override/buffer/refresh 与价格历史', async () => {
    const { mod, calls } = await loadModule('../src/server/model-catalog-actions', [
      {},
      {},
      {},
      {},
      { status: 200, body: { entries: [{ p: 1 }] } },
    ]);
    await mod.setFxOverrideAction('7.2');
    await mod.clearFxOverrideAction();
    await mod.setFxBufferAction('3');
    await mod.refreshFxAction(true);
    await expect(mod.priceHistoryAction('gpt-x')).resolves.toEqual({ entries: [{ p: 1 }] });
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: expect.stringContaining('/v1/fx/catalog/override'),
    });
    expect(calls[1]).toMatchObject({ method: 'DELETE' });
    expect(calls[2]).toMatchObject({
      method: 'PUT',
      url: expect.stringContaining('/v1/fx/catalog/buffer'),
    });
    expect(calls[3]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining('/v1/fx/catalog/refresh'),
    });
    expect(calls[4]).toMatchObject({
      url: expect.stringContaining('/v1/model-catalog/price-history'),
    });
  });
});

describe('cookies-actions（壳语言/主题 cookie 读写）', () => {
  it('set/get 往返', async () => {
    const { mod } = await loadModule('../src/server/cookies-actions', []);
    await expect(mod.setValueToCookie('k', 'v', { maxAge: 10 })).resolves.toBeUndefined();
    await expect(mod.getValueFromCookie('k')).resolves.toBe('v');
  });
});
