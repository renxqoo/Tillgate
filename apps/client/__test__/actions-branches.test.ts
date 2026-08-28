/**
 * 错误分支补集：每个 action 的 ApiError 上浮与网络层失败回落（
 * server action 不允许无提示 reject——fetch 级失败必须翻译为可见 error）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defined } from './defined';

const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: defined(jar.get(name)) } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
    has: (name: string) => jar.has(name),
  })),
  headers: vi.fn(async () => new Headers({ 'accept-language': 'en' })),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createKeyAction, revokeKeyAction, updateKeyAction } from '../src/server/actions/keys';
import { inviteMemberAction, setMemberQuotaAction } from '../src/server/actions/orgs';
import {
  purchaseSubscriptionAction,
  renewSubscriptionAction,
} from '../src/server/actions/subscription';
import { changePasswordAction, updateDisplayNameAction } from '../src/server/actions/settings';
import { redeemAction } from '../src/server/actions/redeem';
import { createPaymentAction } from '../src/server/actions/billing';
import { deleteAppAction } from '../src/server/actions/apps';
import { loginAction, registerAction } from '../src/server/actions/auth';
import { fetchPublicPricing } from '../src/server/public-pricing';
import { stripAuthParams } from '../src/features/auth/auth-url';
import { signedAmountTone } from '../src/features/shared/money-tone';
import { formatMoney, unitWord } from '../src/features/shared/format';
import { highlight } from '../src/features/public/highlight';
import { buildPages } from '../src/features/shared/pager-pages';
import { listHref } from '../src/server/list-query';

let calls: Array<{ url: string }>;
let responses: Array<{ status: number; body: unknown }>;
let failNetwork = false;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      calls.push({ url: String(url) });
      if (failNetwork) throw new TypeError('network down');
      const next = responses.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }),
  );
}

const errBody = (code: string, message: string) => ({ error: { code, message } });

beforeEach(() => {
  calls = [];
  responses = [];
  failNetwork = false;
  jar.clear();
  vi.unstubAllGlobals();
  stubFetch();
});

describe('keys 错误分支', () => {
  it('create：ApiError 上浮 message；网络失败回落 common 文案', async () => {
    responses.push({ status: 409, body: errBody('x', '重名') });
    expect((await createKeyAction({ name: 'k' })).error).toBe('重名');
    failNetwork = true;
    expect((await createKeyAction({ name: 'k' })).error).toBe('createFailed');
  });

  it('update/revoke：两类失败路径', async () => {
    responses.push({ status: 400, body: errBody('x', '限额非法') });
    expect((await updateKeyAction(1, { name: 'n' })).error).toBe('限额非法');
    failNetwork = true;
    expect((await updateKeyAction(1, { name: 'n' })).error).toBe('updateFailed');
    failNetwork = false;
    responses.push({ status: 400, body: errBody('x', '已吊销') });
    expect((await revokeKeyAction(1)).error).toBe('已吊销');
    failNetwork = true;
    expect((await revokeKeyAction(1)).error).toBe('revokeFailed');
  });
});

describe('orgs 错误分支', () => {
  it('invite/quota：ApiError 与网络失败', async () => {
    responses.push({ status: 422, body: errBody('x', '已是成员') });
    expect((await inviteMemberAction(1, 'a@x.dev')).error).toBe('已是成员');
    failNetwork = true;
    expect((await inviteMemberAction(1, 'a@x.dev')).error).toBe('inviteFailed');
    failNetwork = false;
    responses.push({ status: 400, body: errBody('x', 'bad') });
    expect((await setMemberQuotaAction(1, 2, { dailySpendLimit: '1' })).error).toBe('bad');
    failNetwork = true;
    expect((await setMemberQuotaAction(1, 2, {})).error).toBe('saveFailed');
  });
});

describe('subscription 错误分支', () => {
  it('purchase/renew：ApiError 上浮与网络回落', async () => {
    responses.push({ status: 402, body: errBody('billing.insufficient_funds', '余额不足') });
    expect((await purchaseSubscriptionAction(1)).error).toBe('余额不足');
    failNetwork = true;
    expect((await purchaseSubscriptionAction(1)).error).toBe('purchaseFailed');
    failNetwork = false;
    responses.push({ status: 422, body: errBody('x', '规则') });
    expect((await renewSubscriptionAction(2)).error).toBe('规则');
    failNetwork = true;
    expect((await renewSubscriptionAction(2)).error).toBe('renewFailed');
  });
});

describe('settings 错误分支', () => {
  it('changePassword：ApiError 带 code；网络回落', async () => {
    responses.push({ status: 401, body: errBody('identity.invalid_credentials', '旧密码错误') });
    expect(await changePasswordAction({ oldPassword: 'a', newPassword: 'newpass123' })).toEqual({
      error: '旧密码错误',
      code: 'identity.invalid_credentials',
    });
    failNetwork = true;
    expect(
      (await changePasswordAction({ oldPassword: 'a', newPassword: 'newpass123' })).error,
    ).toBe('changeFailedRetry');
  });

  it('updateDisplayName：ApiError 与网络回落', async () => {
    responses.push({ status: 400, body: errBody('x', '名字非法') });
    expect((await updateDisplayNameAction({ displayName: 'x' })).error).toBe('名字非法');
    failNetwork = true;
    expect((await updateDisplayNameAction({ displayName: 'x' })).error).toBe('changeFailedRetry');
  });
});

describe('redeem / billing / apps 错误分支', () => {
  it('redeem：ApiError 上浮与网络回落', async () => {
    responses.push({ status: 404, body: errBody('billing.redeem_invalid_code', '码无效') });
    expect((await redeemAction('X')).error).toBe('码无效');
    failNetwork = true;
    expect((await redeemAction('X')).error).toBe('redeemFailed');
  });

  it('createPayment：ApiError 上浮与网络回落', async () => {
    responses.push({ status: 422, body: errBody('x', '金额超限') });
    expect((await createPaymentAction('epay', '1')).error).toBe('金额超限');
    failNetwork = true;
    expect((await createPaymentAction('epay', '1')).error).toBe('orderFailed');
  });

  it('deleteApp：网络失败回落 common 文案', async () => {
    failNetwork = true;
    expect((await deleteAppAction(1)).error).toBe('deleteFailed');
  });
});

describe('auth 兜底分支', () => {
  it('login：响应既非 code_required 也非 success → loginFailed 兜底', async () => {
    responses.push({ status: 200, body: { kind: 'weird' } });
    const fd = new FormData();
    fd.append('email', 'u@x.dev');
    fd.append('password', 'pw');
    expect(await loginAction(fd)).toEqual({ error: 'loginFailed' });
    failNetwork = true;
    expect((await loginAction(fd)).error).toBe('fetchError');
  });

  it('register：同款兜底与网络回落', async () => {
    responses.push({ status: 200, body: {} });
    const fd = new FormData();
    fd.append('email', 'u@x.dev');
    fd.append('password', 'pw123456');
    expect(await registerAction(fd)).toEqual({ error: 'registerFailed' });
    failNetwork = true;
    expect((await registerAction(fd)).error).toBe('fetchError');
  });
});

describe('剩余分支补线', () => {
  it('public-pricing：非法 page/pageSize 跳参；可注入 fetch', async () => {
    responses.push({ status: 200, body: { models: [], total: 0, page: 1, pageSize: 20 } });
    await fetchPublicPricing({ page: Number.NaN, pageSize: Number.NaN });
    expect(defined(calls[0], 'calls[0]').url).not.toContain('page=');
    expect(defined(calls[0], 'calls[0]').url).not.toContain('pageSize=');
    const injected: string[] = [];
    await fetchPublicPricing({}, (async (input: unknown) => {
      injected.push(String(input));
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    expect(injected[0]).toContain('/v1/pricing');
  });

  it('auth-url：数组空首值视为未传', () => {
    expect(stripAuthParams('/login', { next: [] }, ['next'])).toBeNull();
  });

  it('money-tone：number 入参分支', () => {
    expect(signedAmountTone(2.5, 'en')).toContain('emerald');
    expect(signedAmountTone(-2.5, 'en')).toContain('destructive');
  });

  it('format：unitWord char/request 词表；formatMoney 数字入参', () => {
    expect(unitWord('char', 'en')).toBe('char');
    expect(unitWord('request', 'en')).toBe('request');
    expect(formatMoney(12.3456, 'en')).toBe('¥12.3456');
  });

  it('listHref：数组键可被 override 删除', () => {
    expect(listHref({ t: ['a', 'b'] }, { t: undefined })).toBe('');
  });

  it('pager-pages：单页与边界窗口', () => {
    expect(buildPages(1, 1)).toEqual([1]);
    expect(buildPages(1, 9)).toHaveLength(9);
  });

  it('highlight：缺省标签走 bash', async () => {
    const html = await highlight('ls -la');
    expect(html).toContain('<pre');
  }, 20_000);
});
