/**
 * 错误/守卫分支补集（第二批）:orgs 邀请撤销/移除成员、settings 改密与显示名守卫、
 * keys 创建守卫与部分更新字段矩阵、apps 轮换/删除失败面、auth 找回密码族、
 * plan-format/samples 零覆盖纯函数、optionalMe 演示注入分支。
 * 与 actions-branches.test.ts 同款装置（fetch 队列 + 网络失败开关）。
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

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createKeyAction, updateKeyAction, exportKeysAction } from '../src/server/actions/keys';
import { revokeInvitationAction, removeMemberAction } from '../src/server/actions/orgs';
import { changePasswordAction, updateDisplayNameAction } from '../src/server/actions/settings';
import { createAppAction, rotateSecretAction, deleteAppAction } from '../src/server/actions/apps';
import { forgotAction, forgotResetAction } from '../src/server/actions/auth';
import { optionalMe } from '../src/server/session';
import { planPeriodLabel } from '../src/features/subscription/plan-format';
import { buildSamples } from '../src/features/public/landing/samples';

let calls: Array<{ url: string; init?: RequestInit }>;
let responses: Array<{ status: number; body: unknown }>;
let failNetwork = false;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
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
  delete process.env.DEV_FAKE_ME;
  vi.unstubAllGlobals();
  stubFetch();
});

describe('orgs 撤销邀请/移除成员失败面', () => {
  it('revokeInvitation:成功空错;ApiError 上浮;网络失败回落', async () => {
    expect(await revokeInvitationAction(1, 2)).toEqual({});
    responses.push({ status: 404, body: errBody('x', '邀请不存在') });
    expect((await revokeInvitationAction(1, 2)).error).toBe('邀请不存在');
    failNetwork = true;
    expect((await revokeInvitationAction(1, 2)).error).toBe('revokeFailed');
  });

  it('removeMember:成功空错;ApiError 上浮;网络失败回落', async () => {
    expect(await removeMemberAction(1, 5)).toEqual({});
    responses.push({ status: 403, body: errBody('x', '无权移除') });
    expect((await removeMemberAction(1, 5)).error).toBe('无权移除');
    failNetwork = true;
    expect((await removeMemberAction(1, 5)).error).toBe('removeFailed');
  });
});

describe('settings 改密/显示名守卫矩阵', () => {
  it.each([
    [{ oldPassword: '', newPassword: '12345678' }, 'oldPasswordRequired'],
    [{ oldPassword: 'a', newPassword: 'short' }, 'newPasswordMin'],
    [{ oldPassword: 'a', newPassword: 'x'.repeat(129) }, 'newPasswordMax'],
  ])('改密校验拦截 %j → %s（不发请求）', async (input, expected) => {
    expect((await changePasswordAction(input as never)).error).toBe(expected);
    expect(calls).toHaveLength(0);
  });

  it('改密成功带 token 轮换会话;无 token 不动 jar', async () => {
    responses.push({ status: 200, body: { token: 'next-token' } });
    expect(await changePasswordAction({ oldPassword: 'a', newPassword: '12345678' })).toEqual({});
    expect(jar.get('ag_session')).toBe('next-token');
    responses.push({ status: 200, body: {} });
    await changePasswordAction({ oldPassword: 'a', newPassword: '12345678' });
    expect(jar.get('ag_session')).toBe('next-token');
  });

  it('改密 ApiError 带 code;网络失败回落', async () => {
    responses.push({ status: 400, body: errBody('auth.password_mismatch', '旧密码错误') });
    const res = await changePasswordAction({ oldPassword: 'a', newPassword: '12345678' });
    expect(res).toMatchObject({ error: '旧密码错误', code: 'auth.password_mismatch' });
    failNetwork = true;
    expect((await changePasswordAction({ oldPassword: 'a', newPassword: '12345678' })).error).toBe(
      'changeFailedRetry',
    );
  });

  it.each([
    [{ displayName: '   ' }, 'nameRequired'],
    [{ displayName: 'x'.repeat(33) }, 'nameTooLong'],
  ])('显示名校验拦截 %j → %s', async (input, expected) => {
    expect((await updateDisplayNameAction(input as never)).error).toBe(expected);
  });

  it('显示名成功回显;ApiError 上浮;网络失败回落', async () => {
    responses.push({ status: 200, body: { displayName: '新名' } });
    expect(await updateDisplayNameAction({ displayName: '新名' })).toEqual({
      displayName: '新名',
    });
    responses.push({ status: 409, body: errBody('x', '重名') });
    expect((await updateDisplayNameAction({ displayName: 'n' })).error).toBe('重名');
    failNetwork = true;
    expect((await updateDisplayNameAction({ displayName: 'n' })).error).toBe('changeFailedRetry');
  });
});

describe('keys 守卫与部分更新字段矩阵', () => {
  it('create 空名拦截（不发请求）', async () => {
    expect((await createKeyAction({ name: '   ' })).error).toBe('nameRequired');
    expect(calls).toHaveLength(0);
  });

  it('update 全字段齐发;仅单字段时其余不落 body', async () => {
    responses.push({ status: 200, body: {} });
    await updateKeyAction(1, {
      name: 'n',
      remark: '',
      rpmLimit: 5,
      tpmLimit: 6,
      dailySpendLimit: '7',
    });
    const full = JSON.parse(String(calls[0]!.init?.body));
    expect(full).toEqual({
      name: 'n',
      remark: null,
      rpmLimit: 5,
      tpmLimit: 6,
      dailySpendLimit: '7',
    });

    responses.push({ status: 200, body: {} });
    await updateKeyAction(1, { rpmLimit: 9 });
    const partial = JSON.parse(String(calls[1]!.init?.body));
    expect(partial).toEqual({ rpmLimit: 9 });
  });

  it('export 空页即止;ApiError 与网络失败回落', async () => {
    responses.push({ status: 200, body: { rows: [] } });
    expect(await exportKeysAction()).toEqual({ rows: [] });
    responses.push({ status: 500, body: errBody('x', '后端炸了') });
    expect((await exportKeysAction()).error).toBe('后端炸了');
    failNetwork = true;
    expect((await exportKeysAction()).error).toBe('loadFailed');
  });
});

describe('apps 创建/轮换/删除失败面', () => {
  it('create:成功返回 app;ApiError 上浮;网络失败回落', async () => {
    responses.push({ status: 201, body: { id: 1, name: 'a' } });
    expect((await createAppAction({ name: 'a' })).app).toMatchObject({ id: 1 });
    responses.push({ status: 409, body: errBody('x', '重名') });
    expect((await createAppAction({ name: 'a' })).error).toBe('重名');
    failNetwork = true;
    expect((await createAppAction({ name: 'a' })).error).toBe('createFailed');
  });

  it('rotateSecret:成功返回 secret;两类失败', async () => {
    responses.push({ status: 200, body: { clientSecret: 'sk-new' } });
    const rotated = await rotateSecretAction(3);
    expect((rotated as { clientSecret?: string }).clientSecret).toBe('sk-new');
    responses.push({ status: 404, body: errBody('x', '不存在') });
    expect((await rotateSecretAction(3)).error).toBe('不存在');
    failNetwork = true;
    expect((await rotateSecretAction(3)).error).toBeTruthy();
  });

  it('delete:成功空错;两类失败', async () => {
    expect(await deleteAppAction(3)).toEqual({});
    responses.push({ status: 404, body: errBody('x', '不存在') });
    expect((await deleteAppAction(3)).error).toBe('不存在');
    failNetwork = true;
    expect((await deleteAppAction(3)).error).toBe('deleteFailed');
  });
});

describe('auth 找回密码族失败面', () => {
  it('forgot:空邮箱拦截;ApiError 上浮;网络失败回落', async () => {
    const form = new FormData();
    expect((await forgotAction(form)).error).toBe('emailRequired');
    form.set('email', 'a@b.c');
    responses.push({ status: 429, body: errBody('x', '太频繁') });
    expect((await forgotAction(form)).error).toBe('太频繁');
    failNetwork = true;
    expect((await forgotAction(form)).error).toBeTruthy();
  });

  it('forgotReset:成功回 ok;ApiError 上浮;网络失败回落', async () => {
    responses.push({ status: 200, body: { ok: true } });
    expect(await forgotResetAction('tok', '12345678')).toEqual({ ok: true });
    responses.push({ status: 400, body: errBody('x', '令牌失效') });
    expect((await forgotResetAction('tok', '12345678')).error).toBe('令牌失效');
    failNetwork = true;
    expect((await forgotResetAction('tok', '12345678')).error).toBeTruthy();
  });
});

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;
const tPlain = (key: string) => key;

describe('零覆盖纯函数补测', () => {
  it('planPeriodLabel:30→月付,365→年付,其余按天', () => {
    const tt = t as unknown as Parameters<typeof planPeriodLabel>[1];
    expect(planPeriodLabel(30, tt)).toBe('monthly');
    expect(planPeriodLabel(365, tt)).toBe('yearly');
    expect(planPeriodLabel(90, tt)).toBe('periodDays:{"days":90}');
  });

  it('buildSamples:三语言示例含真实 Base URL', () => {
    const samples = buildSamples(tPlain as never, 'https://api.example.com');
    expect(Object.keys(samples).toSorted()).toEqual(['curl', 'node', 'py']);
    expect(samples.node).toContain('https://api.example.com');
    expect(samples.py).toContain('https://api.example.com');
    expect(samples.curl).toContain('https://api.example.com');
  });

  it('optionalMe:DEV_FAKE_ME=1 注入演示会话(不触后端)', async () => {
    process.env.DEV_FAKE_ME = '1';
    const me = await optionalMe();
    expect(me).not.toBeNull();
    expect(calls).toHaveLength(0);
    delete process.env.DEV_FAKE_ME;
    responses.push({ status: 200, body: { id: 7 } });
    expect((await optionalMe())?.id).toBe(7);
  });
});
