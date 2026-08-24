'use server';

/**
 * 认证 Server Action：登录（两级验证码）/ 注册（两步验证码）/ 登出。
 * 全部经 BFF facade 出站（accept-language + x-forwarded-for 随行——B7 修复），
 * 错误 message 由 client-api 按 accept-language 本地化后原样上浮 toast。
 */
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ApiError, type AuthStepResult, type LoginVerifyResult } from '@tillgate/api-client';
import { clearSessionCookie, getSessionToken, setSessionToken } from '@tillgate/api-client/next';

import { createClientApi } from '../api';
import { safeNext } from '../next-url';

/** API 不可达（网络层失败）的可见反馈——server action reject 在客户端无 toast */
async function fetchError(): Promise<string> {
  const t = await getTranslations('auth');
  return t('fetchError');
}

export async function loginAction(
  formData: FormData,
): Promise<{ error?: string; challengeId?: string }> {
  const t = await getTranslations('auth');
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) return { error: t('emailPasswordRequired') };

  let body: AuthStepResult;
  try {
    body = await createClientApi().post<AuthStepResult>('/v1/auth/login', { email, password });
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : await fetchError() };
  }
  if (body.kind === 'code_required' && body.challengeId) {
    return { challengeId: body.challengeId };
  }
  if (body.kind === 'success' && body.token) {
    await setSessionToken(body.token);
    redirect('/dashboard');
  }
  return { error: t('loginFailed') };
}

/** 登录第二步：验证邮箱验证码，成功落会话并按 next 白名单回跳 */
export async function verifyLoginCodeAction(
  challengeId: string,
  code: string,
  next?: string | null,
): Promise<{ error?: string }> {
  let body: LoginVerifyResult;
  try {
    body = await createClientApi().post<LoginVerifyResult>('/v1/auth/login/verify', {
      challengeId,
      code,
    });
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : await fetchError() };
  }
  await setSessionToken(body.token);
  redirect(safeNext(next));
}

/** 注册第一步：captchaToken 由浏览器 Turnstile widget 产生、原样转发；code 上浮供换票 */
export async function registerAction(formData: FormData): Promise<{
  error?: string;
  code?: string;
  challengeId?: string;
}> {
  const t = await getTranslations('auth');
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const captchaToken = String(formData.get('captchaToken') ?? '');
  const aff = String(formData.get('aff') ?? '').trim();
  if (!email || !password) return { error: t('emailPasswordRequired') };

  let body: AuthStepResult;
  try {
    body = await createClientApi().post<AuthStepResult>('/v1/auth/register', {
      email,
      password,
      ...(captchaToken ? { captchaToken } : {}),
      ...(aff ? { aff } : {}),
    });
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message, code: e.code };
    return { error: await fetchError() };
  }
  if (body.kind === 'code_required' && body.challengeId) {
    return { challengeId: body.challengeId };
  }
  if (body.kind === 'success' && body.token) {
    await setSessionToken(body.token);
    redirect('/dashboard');
  }
  return { error: t('registerFailed') };
}

/** 注册第二步：验证码建号+自动登录（aff 邀请归因透传） */
export async function registerVerifyAction(
  challengeId: string,
  code: string,
  aff?: string | null,
): Promise<{ error?: string }> {
  let body: LoginVerifyResult;
  try {
    body = await createClientApi().post<LoginVerifyResult>('/v1/auth/register/verify', {
      challengeId,
      code,
      ...(aff ? { aff } : {}),
    });
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : await fetchError() };
  }
  await setSessionToken(body.token);
  redirect('/dashboard');
}

/** 注销：先吊销服务端 jti（泄露副本即失效）再清本地 cookie；吊销 best-effort */
export async function logoutAction(): Promise<void> {
  try {
    const token = await getSessionToken();
    if (token) await createClientApi().post('/v1/auth/logout');
  } catch {
    // 吊销失败不阻塞登出（本地 cookie 已清；服务端令牌最迟 TTL 自然过期）
  }
  await clearSessionCookie();
  redirect('/login');
}

/**
 * 找回密码（链接制）:发起（仅邮箱——存在性不泄漏,恒 {ok}）→ 邮箱收到一次性
 * 重置链接（30 分钟有效）→ /reset-password 页提交新密码（token 单次消费,
 * 重置成功该账号全部旧会话下线）→ 成功页倒计时回登录。
 */
export async function forgotAction(formData: FormData): Promise<{ ok?: boolean; error?: string }> {
  const t = await getTranslations('auth');
  const email = String(formData.get('email') ?? '').trim();
  if (!email) return { error: t('emailRequired') };
  try {
    const body = await createClientApi().post<{ ok: true }>('/v1/auth/forgot', { email });
    return { ok: body.ok };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : await fetchError() };
  }
}

export async function forgotResetAction(
  token: string,
  password: string,
): Promise<{ ok?: boolean; error?: string }> {
  let body: { ok: true };
  try {
    body = await createClientApi().post<{ ok: true }>('/v1/auth/forgot/reset', {
      token,
      password,
    });
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : await fetchError() };
  }
  return { ok: body.ok };
}
