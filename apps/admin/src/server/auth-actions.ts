'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';
import {
  clearAdminSessionCookie,
  getAdminApiBase,
  setAdminSessionToken,
} from '@tillgate/api-client/next';

import { adminApi } from './admin-api';

/**
 * auth API fetch 兜底：API 不可达（fetch 抛错）时返回结构化 error——
 * 登录失败必须有可见反馈（server action 异常 reject 在客户端无 toast）。
 * 登录/验码在会话建立之前，无 client 可用，故走裸 fetch（基地址经装配层解析）。
 */
async function authFetch(
  url: string,
  init: RequestInit,
): Promise<Response | { fetchError: string }> {
  const t = await getTranslations('auth');
  try {
    return await fetch(url, init);
  } catch {
    return { fetchError: t('serviceUnavailable') };
  }
}

function isFetchError(r: Response | { fetchError: string }): r is { fetchError: string } {
  return 'fetchError' in r;
}

/**
 * 管理员登录（admin-api，Bearer 会话）。
 *   - 凭证：email + password；第二因子二分：TOTP 绑定 → {totpRequired:true}（客户端
 *     改走 loginTotpAction）;邮箱码开启 → {twoFactorRequired, challengeId}
 *   - 会话：token 由 BFF 持有（ag_admin_session cookie 值即 JWT）
 */
/** /v1/auth/login 响应体（错误信封 / 2FA 挑战 / 成功 token） */
interface LoginResponseBody {
  error?: { message?: string };
  twoFactorRequired?: boolean;
  method?: 'totp' | 'email';
  challengeId?: string;
  token?: string;
}

/** 登录响应分流结果：失败 / TOTP 挑战 / 邮箱码挑战 / 成功（判别联合，token 收窄非空） */
type LoginOutcome =
  | { kind: 'error'; error: string }
  | { kind: 'totp' }
  | { kind: 'challenge'; challengeId: string }
  | { kind: 'ok'; token: string };

/** 登录响应分流：失败 / TOTP 挑战 / 邮箱码挑战 / 成功 token */
function resolveLoginOutcome(
  res: Response,
  body: LoginResponseBody | null,
  messages: { loginFailedStatus: (status: number) => string; noToken: string },
): LoginOutcome {
  if (!res.ok) {
    return { kind: 'error', error: body?.error?.message ?? messages.loginFailedStatus(res.status) };
  }
  if (body?.twoFactorRequired && body.method === 'totp') {
    return { kind: 'totp' };
  }
  if (body?.twoFactorRequired && body.challengeId) {
    return { kind: 'challenge', challengeId: body.challengeId };
  }
  if (!body?.token) return { kind: 'error', error: messages.noToken };
  return { kind: 'ok', token: body.token };
}

export async function loginAction(
  formData: FormData,
): Promise<{ error?: string; challengeId?: string; totpRequired?: boolean }> {
  const t = await getTranslations('auth');
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) return { error: t('emailPasswordRequired') };

  const r = await authFetch(`${getAdminApiBase()}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    cache: 'no-store',
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;

  const body = (await res.json().catch(() => null)) as LoginResponseBody | null;
  const outcome = resolveLoginOutcome(res, body, {
    loginFailedStatus: (status) => t('loginFailedStatus', { status }),
    noToken: t('noToken'),
  });
  switch (outcome.kind) {
    case 'error': {
      return { error: outcome.error };
    }
    case 'totp': {
      return { totpRequired: true };
    }
    case 'challenge': {
      return { challengeId: outcome.challengeId };
    }
    case 'ok': {
      await setAdminSessionToken(outcome.token);
      redirect('/dashboard');
    }
  }
}

/** 第二步（TOTP）：重验凭证 + 验证器 6 位码或 10 位恢复码 */
export async function loginTotpAction(
  email: string,
  password: string,
  code: string,
): Promise<{ error?: string }> {
  const t = await getTranslations('auth');
  if (!/^([0-9]{6}|[A-Z0-9]{10})$/.test(code)) return { error: t('invalidCode') };
  const r = await authFetch(`${getAdminApiBase()}/v1/auth/login/totp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, code }),
    cache: 'no-store',
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;
  const body = (await res.json().catch(() => null)) as {
    token?: string;
    error?: { message?: string };
  } | null;
  if (!res.ok || !body?.token) {
    return { error: body?.error?.message ?? t('loginFailedStatus', { status: res.status }) };
  }
  await setAdminSessionToken(body.token);
  redirect('/dashboard');
}

/** 第二步：提交邮箱验证码完成登录 */
export async function verifyLoginAction(
  challengeId: string,
  code: string,
): Promise<{ error?: string }> {
  const t = await getTranslations('auth');
  if (!/^\d{6}$/.test(code)) return { error: t('invalidCode') };
  const r = await authFetch(`${getAdminApiBase()}/v1/auth/login/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code }),
    cache: 'no-store',
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;
  const body = (await res.json().catch(() => null)) as {
    token?: string;
    error?: { message?: string };
  } | null;
  if (!res.ok || !body?.token) {
    return { error: body?.error?.message ?? t('verifyFailedStatus', { status: res.status }) };
  }
  await setAdminSessionToken(body.token);
  redirect('/dashboard');
}

/** 2FA 开关确认码发送（向本人邮箱发码,60s 冷却） */
export async function requestTwoFactorCodeAction(): Promise<{
  challengeId?: string;
  error?: string;
}> {
  const t = await getTranslations('auth');
  try {
    const body = await adminApi().post<{ challengeId: string }>('/v1/me/two-factor/code');
    return { challengeId: body.challengeId };
  } catch (error) {
    return {
      error: error instanceof ApiError ? error.message : t('operationFailedStatus', { status: 0 }),
    };
  }
}

/** 邮箱验证码二次登录开关（设置页；邮箱码自证——challengeId 来自发码 action） */
export async function setTwoFactorAction(
  enabled: boolean,
  challengeId: string,
  code: string,
): Promise<{ error?: string }> {
  const t = await getTranslations('auth');
  try {
    await adminApi().post('/v1/me/two-factor', { enabled, challengeId, code });
  } catch (error) {
    return {
      error: error instanceof ApiError ? error.message : t('operationFailedStatus', { status: 0 }),
    };
  }
  revalidatePath('/settings');
  return {};
}

/** 注销：先吊销服务端 jti（泄露副本即失效）再清本地 cookie；吊销 best-effort */
export async function logoutAction(): Promise<void> {
  try {
    await adminApi().post('/v1/auth/logout');
  } catch {
    // 吊销失败不阻塞登出
  }
  await clearAdminSessionCookie();
  redirect('/login');
}
