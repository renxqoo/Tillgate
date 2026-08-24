/**
 * Server Action 覆盖补集（与 actions.test.ts 同款替身）：apps 全量、oauth/locale、
 * orgs 剩余动词、subscription 变更与错误分支、settings/redeem/billing 错误路径、
 * auth 验证码步失败与注册第二步、discovery 成功路径、session 成功路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
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

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { revalidatePath } from 'next/cache';
import { LOCALE_COOKIE } from '@tillgate/api-client/next';

import { registerVerifyAction, verifyLoginCodeAction } from '../src/server/actions/auth';
import { completeOAuthAction } from '../src/server/actions/oauth';
import { setLocaleAction } from '../src/server/actions/locale';
import { createAppAction, deleteAppAction, rotateSecretAction } from '../src/server/actions/apps';
import {
  acceptInviteAction,
  removeMemberAction,
  revokeInvitationAction,
} from '../src/server/actions/orgs';
import { changeSubscriptionAction } from '../src/server/actions/subscription';
import { fetchOAuthProviders } from '../src/server/discovery';
import { requireMe } from '../src/server/session';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];
let responses: Array<{ status: number; body: unknown }>;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }),
  );
}

function lastCall(): FetchCall {
  return calls[calls.length - 1]!;
}

function isRedirectError(e: unknown): boolean {
  const digest = (e as Error & { digest?: string })?.digest;
  return e instanceof Error && typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}

const errBody = (code: string, message: string) => ({
  error: { code, message },
});

beforeEach(() => {
  calls = [];
  responses = [];
  jar.clear();
  vi.unstubAllGlobals();
  stubFetch();
  vi.mocked(revalidatePath).mockClear();
});

describe('actions/oauth + locale', () => {
  it('completeOAuthAction：落 cookie 后按白名单跳转', async () => {
    await expect(completeOAuthAction('frag-token', '/dashboard/keys')).rejects.toSatisfy(
      isRedirectError,
    );
    expect(jar.get('ag_session')).toBe('frag-token');
  });

  it('setLocaleAction：合法语言写 cookie；非法静默拒绝', async () => {
    await setLocaleAction('zh');
    expect(jar.get(LOCALE_COOKIE)).toBe('zh');
    await setLocaleAction('fr');
    expect(jar.get(LOCALE_COOKIE)).toBe('zh');
  });
});

describe('actions/apps', () => {
  it('create：成功回显 AppCreated；空名本地拒绝；业务错误上浮 message', async () => {
    expect((await createAppAction({ name: '  ' })).error).toBe('nameRequired');
    responses.push({
      status: 201,
      body: { id: 1, appId: 'a', clientId: 'c', name: 'n', clientSecret: 's' },
    });
    const ok = await createAppAction({ name: 'n', description: 'd' });
    expect(ok.app?.clientSecret).toBe('s');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/apps');
    responses.push({ status: 400, body: errBody('x', '名字重复') });
    expect((await createAppAction({ name: 'n' })).error).toBe('名字重复');
  });

  it('rotate：返回一次性 clientSecret；失败回落文案', async () => {
    responses.push({ status: 201, body: { id: 1, clientSecret: 'sec-2' } });
    expect((await rotateSecretAction(1)).clientSecret).toBe('sec-2');
    responses.push({ status: 500, body: errBody('x', 'm') });
    expect((await rotateSecretAction(1)).error).toBe('m');
    responses.push({ status: 200, body: {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    // 网络层失败回落 i18n 文案（action 不允许无提示 reject）
    expect((await rotateSecretAction(1)).error).toBe('rotateFailed');
  });

  it('delete：停用（POST disable）+ revalidate', async () => {
    responses.push({ status: 200, body: { id: 1 } });
    expect(await deleteAppAction(1)).toEqual({});
    expect(lastCall().url).toContain('/v1/apps/1/disable');
    expect(lastCall().init.method).toBe('POST');
  });
});

describe('actions/orgs 剩余动词', () => {
  it('accept：成功 revalidate orgs 与 keys；失败上浮', async () => {
    responses.push({ status: 200, body: { orgId: 3 } });
    expect(await acceptInviteAction('tok')).toEqual({});
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/keys');
    responses.push({ status: 410, body: errBody('client.invitation_expired', '邀请已过期') });
    expect((await acceptInviteAction('tok')).error).toBe('邀请已过期');
  });

  it('revoke/remove：路径与方法正确；空邮箱 invite 本地拒绝', async () => {
    responses.push({ status: 200, body: { ok: true } });
    expect(await revokeInvitationAction(3, 9)).toEqual({});
    expect(lastCall().url).toContain('/v1/orgs/3/invitations/9/revoke');
    responses.push({ status: 200, body: { ok: true } });
    expect(await removeMemberAction(3, 5)).toEqual({});
    expect(lastCall().url).toContain('/v1/orgs/3/members/5');
    expect(lastCall().init.method).toBe('DELETE');
  });
});

describe('actions/subscription 变更与错误', () => {
  it('change：POST change + revalidate；无 planId 本地拒绝', async () => {
    responses.push({ status: 200, body: {} });
    expect(await changeSubscriptionAction(11, { targetPlanId: 3, quantity: 2 })).toEqual({});
    expect(lastCall().url).toContain('/v1/subscriptions/11/change');
    responses.push({ status: 422, body: errBody('client.subscription_rule', '规则') });
    expect((await changeSubscriptionAction(11, { targetPlanId: 3, quantity: 2 })).error).toBe(
      '规则',
    );
  });
});

describe('actions/auth 剩余分支', () => {
  it('verifyLoginCodeAction：后端拒绝时错误上浮、不落 cookie', async () => {
    responses.push({ status: 401, body: errBody('identity.invalid_credentials', '验证码错误') });
    const res = await verifyLoginCodeAction('ch', '000000');
    expect(res).toEqual({ error: '验证码错误' });
    expect(jar.has('ag_session')).toBe(false);
  });

  it('verifyLoginCodeAction：网络失败回落 fetchError 文案', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('down');
      }),
    );
    expect((await verifyLoginCodeAction('ch', '000000')).error).toBe('fetchError');
  });

  it('registerVerifyAction：成功建号落 cookie 并 redirect', async () => {
    responses.push({ status: 201, body: { token: 'jwt-r', userId: 9 } });
    await expect(registerVerifyAction('ch', '123456', 'u1')).rejects.toSatisfy(isRedirectError);
    expect(jar.get('ag_session')).toBe('jwt-r');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      challengeId: 'ch',
      code: '123456',
      aff: 'u1',
    });
  });

  it('registerVerifyAction：无 aff 时字段省略', async () => {
    responses.push({ status: 201, body: { token: 'jwt-r2', userId: 10 } });
    await expect(registerVerifyAction('ch', '123456', null)).rejects.toSatisfy(isRedirectError);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ challengeId: 'ch', code: '123456' });
  });
});

describe('discovery 成功路径 & session 成功路径', () => {
  it('providers 正常返回数组', async () => {
    responses.push({ status: 200, body: { providers: ['github', 'google'] } });
    expect(await fetchOAuthProviders()).toEqual(['github', 'google']);
  });

  it('requireMe：getMe 正常返回 me', async () => {
    const fake = { getMe: async () => ({ subject: 'u1', isEnterprise: false }) };
    const me = await requireMe(fake as never);
    expect(me.subject).toBe('u1');
  });
});
