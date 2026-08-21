"use server";

import { redirect } from "next/navigation";

import { apiFetch, clearSessionCookie, getSessionToken, setSessionToken } from "@ai-gateway/api-client";
import { getTranslations } from "next-intl/server";

const CLIENT_API_BASE = process.env.CLIENT_API_BASE!;

/**
 * auth API fetch 兜底：API 不可达（fetch 抛错）时返回结构化 error。
 * server action 以异常 reject 会在客户端变成无提示的失败（无 toast，
 * 只有 console 错误）——登录/注册失败必须有可见反馈。
 */
async function authFetch(url: string, init: RequestInit): Promise<Response | { fetchError: string }> {
  try {
    return await fetch(url, init);
  } catch {
    const t = await getTranslations("auth");
    return { fetchError: t("fetchError") };
  }
}

function isFetchError(r: Response | { fetchError: string }): r is { fetchError: string } {
  return "fetchError" in r;
}

/** 登录/注册响应：两步流 {kind:'code_required', challengeId} 或单步 {kind:'success', token} */
interface AuthStepResult {
  kind?: "code_required" | "success";
  challengeId?: string;
  token?: string;
  error?: { message?: string; code?: string };
}

/**
 * 用户登录 Server Action（client-api，两步：密码 → 邮箱验证码；未强制验证码时单步直落）。
 */
export async function loginAction(formData: FormData): Promise<{ error?: string; challengeId?: string }> {
  const t = await getTranslations("auth");
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: t("emailPasswordRequired") };

  const r = await authFetch(`${CLIENT_API_BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;

  const body = (await res.json().catch(() => null)) as AuthStepResult | null;

  if (res.ok && body?.kind === "code_required" && body.challengeId) {
    return { challengeId: body.challengeId };
  }
  if (res.ok && body?.kind === "success" && body.token) {
    await setSessionToken(body.token);
    redirect("/dashboard");
  }
  return { error: body?.error?.message ?? t("loginFailedStatus", { status: res.status }) };
}

/** 第二步：验证邮箱验证码，成功落会话并跳转 */
export async function verifyLoginCodeAction(
  challengeId: string,
  code: string,
  next?: string | null,
): Promise<{ error?: string }> {
  const t = await getTranslations("auth");
  const r = await authFetch(`${CLIENT_API_BASE}/v1/auth/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId, code }),
    cache: "no-store",
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;

  const body = (await res.json().catch(() => null)) as AuthStepResult | null;
  if (!res.ok || !body?.token) {
    return { error: body?.error?.message ?? t("verifyFailedStatus", { status: res.status }) };
  }
  await setSessionToken(body.token);

  // 回跳：只允许站内相对路径，防 open redirect；非法/缺省回落 /dashboard。
  redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
}

/**
 * 邮箱自助注册（两步：注册 → 邮箱验证码 → 建号并自动登录；未强制验证码时单步建号）。
 *   captchaToken 由浏览器 Turnstile widget 产生、经 FormData 上来原样转发。
 */
export async function registerAction(
  formData: FormData,
): Promise<{ error?: string; code?: string; challengeId?: string }> {
  const t = await getTranslations("auth");
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const captchaToken = String(formData.get("captchaToken") ?? "");
  const aff = String(formData.get("aff") ?? "").trim();
  if (!email || !password) return { error: t("emailPasswordRequired") };

  const r = await authFetch(`${CLIENT_API_BASE}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      ...(captchaToken ? { captchaToken } : {}),
      ...(aff ? { aff } : {}),
    }),
    cache: "no-store",
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;

  const body = (await res.json().catch(() => null)) as AuthStepResult | null;

  if (res.ok && body?.kind === "code_required" && body.challengeId) {
    return { challengeId: body.challengeId };
  }
  if (res.ok && body?.kind === "success" && body.token) {
    await setSessionToken(body.token);
    redirect("/dashboard");
  }
  return { error: body?.error?.message ?? t("registerFailedStatus", { status: res.status }), code: body?.error?.code };
}

/** 注册第二步：验证邮箱验证码，成功建号+落会话并跳转（aff 邀请归因透传） */
export async function registerVerifyAction(challengeId: string, code: string, aff?: string | null): Promise<{ error?: string }> {
  const t = await getTranslations("auth");
  const r = await authFetch(`${CLIENT_API_BASE}/v1/auth/register/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId, code, ...(aff ? { aff } : {}) }),
    cache: "no-store",
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;

  const body = (await res.json().catch(() => null)) as AuthStepResult | null;
  if (!res.ok || !body?.token) {
    return { error: body?.error?.message ?? t("verifyFailedStatus", { status: res.status }) };
  }
  await setSessionToken(body.token);
  redirect("/dashboard");
}

/** 注销：先吊销服务端 jti（泄露副本即失效）再清本地 cookie；吊销 best-effort */
export async function logoutAction(): Promise<void> {
  await revokeSessionServerSide();
  await clearSessionCookie();
  redirect("/login");
}

async function revokeSessionServerSide(): Promise<void> {
  try {
    const token = await getSessionToken();
    if (!token) return;
    await apiFetch("/v1/auth/logout", { method: "POST" });
  } catch {
    // 吊销失败不阻塞登出（本地 cookie 已清；服务端令牌最迟 TTL 自然过期）
  }
}
