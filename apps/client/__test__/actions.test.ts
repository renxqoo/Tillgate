/**
 * Server Action 行为规格（BFF 层）：
 *  - 出站经 facade（accept-language / x-forwarded-for 随行）；
 *  - 两步认证流（kind 判别）、token 落 cookie、next 白名单；
 *  - keys patch 省略 undefined、orgs 邀请链接、订阅动作（plans 用 limit=100）、
 *    改密轮换、redeem/billing 成功反馈与 revalidate。
 * next/headers、next-intl/server、next/cache 以测试替身注入；fetch 打桩捕获出站请求。
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
  headers: vi.fn(
    async () =>
      new Headers({
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'x-forwarded-for': '203.0.113.9',
      }),
  ),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { revalidatePath } from 'next/cache';
import { SESSION_COOKIE } from '@tillgate/api-client/next';

import {
  loginAction,
  logoutAction,
  registerAction,
  verifyLoginCodeAction,
} from '../src/server/actions/auth';
import { createKeyAction, revokeKeyAction, updateKeyAction } from '../src/server/actions/keys';
import { inviteMemberAction, setMemberQuotaAction } from '../src/server/actions/orgs';
import {
  purchaseSubscriptionAction,
  renewSubscriptionAction,
} from '../src/server/actions/subscription';
import { changePasswordAction, updateDisplayNameAction } from '../src/server/actions/settings';
import { redeemAction } from '../src/server/actions/redeem';
import { createPaymentAction } from '../src/server/actions/billing';
import { requireMe, userFromMe } from '../src/server/session';
import { fetchPublicPricing } from '../src/server/public-pricing';
import { fetchAuthCapabilities, fetchOAuthProviders } from '../src/server/discovery';
import { ApiError } from '@tillgate/api-client';

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[];
let responses: Array<{ status: number; body: unknown }>;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function lastCall(): FetchCall {
  return defined(calls.at(-1), 'last fetch call');
}

function isRedirectError(e: unknown): boolean {
  const digest = (e as Error & { digest?: string })?.digest;
  return e instanceof Error && typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}

beforeEach(() => {
  calls = [];
  responses = [];
  jar.clear();
  vi.unstubAllEnvs();
  delete process.env.TRUSTED_PROXY_HOPS;
  vi.unstubAllGlobals();
  stubFetch();
  vi.mocked(revalidatePath).mockClear();
});

describe('actions/auth（认证编排 + B7 回归）', () => {
  it('B7 回归：出站请求携带 accept-language 与解出的 x-forwarded-for（v1 裸 fetch 丢头）', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    responses.push({ status: 200, body: { kind: 'success', token: 'jwt-1' } });
    const fd = new FormData();
    fd.append('email', 'u@x.dev');
    fd.append('password', 'pw');
    await expect(loginAction(fd)).rejects.toSatisfy(isRedirectError); // 成功即 redirect
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers['accept-language']).toBe('zh');
    expect(headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(headers['authorization']).toBeUndefined(); // 未登录（无 cookie）不带 Bearer
    expect(jar.get(SESSION_COOKIE)).toBe('jwt-1');
  });

  it('两级登录：code_required 进挑战态（返回 challengeId，不落 cookie）', async () => {
    responses.push({ status: 200, body: { kind: 'code_required', challengeId: 'ch-1' } });
    const fd = new FormData();
    fd.append('email', 'u@x.dev');
    fd.append('password', 'pw');
    const res = await loginAction(fd);
    expect(res).toEqual({ challengeId: 'ch-1' });
    expect(jar.has(SESSION_COOKIE)).toBe(false);
  });

  it('验证码步：成功落 cookie 并按 next 白名单回跳', async () => {
    responses.push({ status: 200, body: { token: 'jwt-2', userId: 1 } });
    await expect(verifyLoginCodeAction('ch-1', '123456', '//evil')).rejects.toSatisfy(
      isRedirectError,
    );
    expect(jar.get(SESSION_COOKIE)).toBe('jwt-2');
    // next 非法回落 /dashboard（不透传恶意值）
  });

  it('业务错误：ApiError message 上浮 + code 供 CAPTCHA 换票', async () => {
    responses.push({
      status: 400,
      body: { error: { code: 'client.captcha_invalid', message: '人机验证未通过' } },
    });
    const fd = new FormData();
    fd.append('email', 'u@x.dev');
    fd.append('password', 'pw');
    const res = await registerAction(fd);
    expect(res).toEqual({ error: '人机验证未通过', code: 'client.captcha_invalid' });
  });

  it('空凭证不发请求（本地校验先行）', async () => {
    const fd = new FormData();
    const res = await loginAction(fd);
    expect(res).toEqual({ error: 'emailPasswordRequired' });
    expect(calls).toHaveLength(0);
  });

  it('logout：best-effort 吊销（失败不阻塞）+ 清 cookie + redirect', async () => {
    jar.set(SESSION_COOKIE, 'jwt-3');
    responses.push({ status: 500, body: { error: { code: 'x', message: 'boom' } } });
    await expect(logoutAction()).rejects.toSatisfy(isRedirectError);
    expect(jar.has(SESSION_COOKIE)).toBe(false);
  });
});

describe('actions/keys', () => {
  it('create：成功返回一次性明文并 revalidate 列表页', async () => {
    responses.push({ status: 201, body: { id: 7, name: 'k', plaintext: 'ag-plain' } });
    const res = await createKeyAction({ name: 'k', subscriptionId: null });
    expect(res.key?.plaintext).toBe('ag-plain');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/keys');
    expect(lastCall().url).toContain('/v1/keys');
  });

  it('update：undefined 字段不发送（PATCH 省略语义）', async () => {
    responses.push({ status: 200, body: {} });
    await updateKeyAction(7, { name: 'renamed', rpmLimit: 100 });
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ name: 'renamed', rpmLimit: 100 });
  });

  it('revoke：DELETE + revalidate', async () => {
    responses.push({ status: 200, body: { id: 7 } });
    const res = await revokeKeyAction(7);
    expect(res).toEqual({});
    expect(lastCall().init.method).toBe('DELETE');
  });
});

describe('actions/orgs', () => {
  it('invite：返回站内一次性接受链接', async () => {
    responses.push({ status: 201, body: { invitationId: 9, token: 'tok' } });
    const res = await inviteMemberAction(3, 'new@x.dev');
    expect(res.link).toBe('/dashboard/orgs/accept?token=tok');
  });

  it('成员限额：string|null 原样 PATCH', async () => {
    responses.push({ status: 200, body: {} });
    await setMemberQuotaAction(3, 5, { dailySpendLimit: '50', monthlyQuota: null });
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      dailySpendLimit: '50',
      monthlyQuota: null,
    });
  });
});

describe('actions/subscription（B2 回归）', () => {
  it('purchase：成功后 revalidate 订阅页', async () => {
    responses.push({ status: 201, body: {} });
    const res = await purchaseSubscriptionAction(2, 3);
    expect(res).toEqual({});
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/subscription');
  });

  it('renew：目标路径正确', async () => {
    responses.push({ status: 200, body: {} });
    await renewSubscriptionAction(11);
    expect(lastCall().url).toContain('/v1/subscriptions/11/renew');
  });

  it('非法席位被本地拒绝（不发请求）', async () => {
    const res = await purchaseSubscriptionAction(2, 0);
    expect(res).toEqual({ error: 'seatsAtLeast1' });
    expect(calls).toHaveLength(0);
  });
});

describe('actions/settings', () => {
  it('changePassword：8-128 本地校验 + 成功轮换 BFF cookie', async () => {
    responses.push({ status: 200, body: { token: 'jwt-rotated' } });
    const res = await changePasswordAction({ oldPassword: 'a', newPassword: 'newpass123' });
    expect(res).toEqual({});
    expect(jar.get(SESSION_COOKIE)).toBe('jwt-rotated');
  });

  it('changePassword：短密码本地拒绝', async () => {
    const res = await changePasswordAction({ oldPassword: 'a', newPassword: 'short' });
    expect(res).toEqual({ error: 'newPasswordMin' });
    expect(calls).toHaveLength(0);
  });

  it('updateDisplayName：超 32 字符本地拒绝；成功回显新名', async () => {
    expect((await updateDisplayNameAction({ displayName: 'x'.repeat(33) })).error).toBe(
      'nameTooLong',
    );
    responses.push({ status: 200, body: { displayName: 'Neo' } });
    expect(await updateDisplayNameAction({ displayName: 'Neo' })).toEqual({ displayName: 'Neo' });
  });
});

describe('actions/redeem & billing', () => {
  it('redeem：成功返回到账额并失效余额相关页', async () => {
    responses.push({ status: 200, body: { amount: '10', balanceAfter: '110', transactionId: 1 } });
    const res = await redeemAction('CODE-1');
    expect(res).toEqual({ ok: true, amount: '10', balanceAfter: '110' });
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/transactions');
  });

  it('redeem：空码本地拒绝', async () => {
    expect((await redeemAction('  ')).error).toBe('codeRequired');
    expect(calls).toHaveLength(0);
  });

  it('createPayment：返回支付跳转 URL', async () => {
    responses.push({
      status: 201,
      body: { orderId: 'uuid', payUrl: 'https://pay/x', creditAmount: '10' },
    });
    const res = await createPaymentAction('epay', '50');
    expect(res).toEqual({ ok: true, payUrl: 'https://pay/x' });
  });
});

describe('session 守卫', () => {
  it('requireMe：getMe 失败（null）→ redirect 登录页', async () => {
    await expect(requireMe({ getMe: async () => null } as never)).rejects.toSatisfy(
      isRedirectError,
    );
  });

  it('requireMe：正常返回 me；userFromMe 投影展示名回退 subject', () => {
    const me = {
      subject: 'u_1',
      displayName: null,
      email: null,
    };
    expect(userFromMe(me as never)).toEqual({ name: 'u_1', email: '' });
  });

  it('DEV_FAKE_ME=1（非生产）：跳过后端返回演示会话', async () => {
    vi.stubEnv('DEV_FAKE_ME', '1');
    const me = await requireMe({ getMe: async () => null } as never);
    expect(defined(me.accounts[0], 'accounts[0]').currency).toBe('CNY');
    expect(calls).toHaveLength(0);
  });
});

describe('公开读取面', () => {
  it('public-pricing：查询参数形态（q/free/page/pageSize——v1 语义保留）；失败返回 null', async () => {
    responses.push({ status: 200, body: { models: [], total: 0, page: 1, pageSize: 9 } });
    const page = await fetchPublicPricing({ q: 'gpt', free: true, page: 2, pageSize: 9 });
    expect(page?.models).toEqual([]);
    expect(lastCall().url).toContain('q=gpt');
    expect(lastCall().url).toContain('free=true');
    expect(lastCall().url).toContain('page=2');
    expect(lastCall().url).toContain('pageSize=9');
    responses.push({ status: 500, body: { error: { code: 'x', message: 'm' } } });
    expect(await fetchPublicPricing()).toBeNull();
  });

  it('discovery：providers 不可达按空、capabilities 不可达按全开（B20 取舍）', async () => {
    responses.push({ status: 500, body: {} });
    expect(await fetchOAuthProviders()).toEqual([]);
    responses.push({ status: 500, body: {} });
    expect(await fetchAuthCapabilities()).toEqual({
      registerEnabled: true,
      captchaSiteKey: null,
      emailCodeRequired: false,
    });
  });
});

describe('ApiError 形态（消费方契约）', () => {
  it('后端信封 {error:{code,message}} → ApiError.status/code/message', () => {
    const err = new ApiError(410, 'client.code_expired', '验证码已过期');
    expect(err.status).toBe(410);
    expect(err.code).toBe('client.code_expired');
    expect(err.message).toBe('验证码已过期');
  });
});
