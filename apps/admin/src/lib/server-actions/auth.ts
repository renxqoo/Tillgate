"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  adminFetch,  clearAdminSessionCookie,
  getAdminSessionToken,
  setAdminSessionToken,
} from "@ai-gateway/api-client";

const ADMIN_API_BASE = process.env.ADMIN_API_BASE ?? "http://localhost:8082";

/**
 * auth API fetch 兜底：API 不可达（fetch 抛错）时返回结构化 error——
 * 登录失败必须有可见反馈（server action 异常 reject 在客户端无 toast）。
 */
async function authFetch(url: string, init: RequestInit): Promise<Response | { fetchError: string }> {
  try {
    return await fetch(url, init);
  } catch {
    return { fetchError: "登录服务暂不可用，请稍后重试" };
  }
}

function isFetchError(r: Response | { fetchError: string }): r is { fetchError: string } {
  return "fetchError" in r;
}

/**
 * 管理员登录（admin-api-v2，Bearer 会话）。
 *   - 凭证：email + password；2FA 开启时第一步返回 {twoFactorRequired, challengeId}
 *   - 会话：token 由 BFF 持有（ag_admin_session cookie 值即 JWT）
 */
export async function loginAction(formData: FormData): Promise<{ error?: string; challengeId?: string }> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "请输入邮箱和密码" };

  const r = await authFetch(`${ADMIN_API_BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;

  const body = (await res.json().catch(() => null)) as
    | { error?: { message?: string }; twoFactorRequired?: boolean; challengeId?: string; token?: string }
    | null;

  if (!res.ok) {
    return { error: body?.error?.message ?? `登录失败 (${res.status})` };
  }
  if (body?.twoFactorRequired && body.challengeId) {
    return { challengeId: body.challengeId };
  }
  if (!body?.token) return { error: "登录成功但未收到会话凭证" };
  await setAdminSessionToken(body.token);
  redirect("/dashboard");
}

/** 第二步：提交邮箱验证码完成登录 */
export async function verifyLoginAction(challengeId: string, code: string): Promise<{ error?: string }> {
  if (!/^\d{6}$/.test(code)) return { error: "请输入 6 位数字验证码" };
  const r = await authFetch(`${ADMIN_API_BASE}/v1/auth/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId, code }),
    cache: "no-store",
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;
  const body = (await res.json().catch(() => null)) as
    | { token?: string; error?: { message?: string } }
    | null;
  if (!res.ok || !body?.token) {
    return { error: body?.error?.message ?? `验证失败 (${res.status})` };
  }
  await setAdminSessionToken(body.token);
  redirect("/dashboard");
}

/** 邮箱验证码二次登录开关（设置页） */
export async function setTwoFactorAction(enabled: boolean): Promise<{ error?: string }> {
  const token = await getAdminSessionToken();
  if (!token) return { error: "未登录" };
  const res = await fetch(`${ADMIN_API_BASE}/v1/me/two-factor`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ enabled }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { error: body?.error?.message ?? `操作失败 (${res.status})` };
  }
  revalidatePath("/settings");
  return {};
}

/** 注销：先吊销服务端 jti（泄露副本即失效）再清本地 cookie；吊销 best-effort */
export async function logoutAction(): Promise<void> {
  try {
    const token = await getAdminSessionToken();
    if (token) await adminFetch("/api/admin/auth/logout", { method: "POST" });
  } catch {
    // 吊销失败不阻塞登出
  }
  await clearAdminSessionCookie();
  redirect("/login");
}
