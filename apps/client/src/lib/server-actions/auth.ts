"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { clearSessionCookie, SESSION_COOKIE } from "@ai-gateway/api-client";

const CLIENT_API_BASE = process.env.CLIENT_API_BASE ?? "http://localhost:8791";
const SESSION_TTL_S = 24 * 60 * 60;

/**
 * auth API fetch 兜底：API 不可达（fetch 抛错）时返回结构化 error。
 * server action 以异常 reject 会在客户端变成无提示的失败（无 toast，
 * 只有 console 错误）——登录/注册失败必须有可见反馈。
 */
async function authFetch(url: string, init: RequestInit): Promise<Response | { fetchError: string }> {
  try {
    return await fetch(url, init);
  } catch {
    return { fetchError: '登录服务暂不可用，请稍后重试' };
  }
}

function isFetchError(r: Response | { fetchError: string }): r is { fetchError: string } {
  return 'fetchError' in r;
}

/**
 * 用户登录 Server Action（client-api 用户面，两步：密码 → 邮箱验证码）。
 *   - 第一步 loginAction：邮箱 + 密码 → 返回 challengeId（验证码已发到邮箱）
 *   - 第二步 verifyLoginCodeAction：验证码 → 签发 ag_session cookie → 跳 /dashboard
 *   - 把返回的 ag_session cookie 复制到 Next.js 的 Cookie 容器（同域 HttpOnly）
 */
export async function loginAction(formData: FormData): Promise<{ error?: string; challengeId?: string }> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "请输入邮箱和密码" };

  const r = await authFetch(`${CLIENT_API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;

  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; challengeId?: string; error?: { message?: string } }
    | null;

  if (res.ok && body?.challengeId) {
    return { challengeId: body.challengeId };
  }
  return {
    error: body?.error?.message ?? `登录失败 (${res.status})`,
  };
}

/** 第二步：验证邮箱验证码，成功落会话并跳转 */
export async function verifyLoginCodeAction(
  challengeId: string,
  code: string,
  next?: string | null,
): Promise<{ error?: string }> {
  const r = await authFetch(`${CLIENT_API_BASE}/api/auth/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId, code }),
    cache: "no-store",
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    return { error: body?.error?.message ?? `验证失败 (${res.status})` };
  }

  const setCookie = res.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!sessionCookie) {
    return { error: "验证成功但未收到会话 Cookie，请重试" };
  }
  const token = sessionCookie.split(";")[0]!.split("=").slice(1).join("=");

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
    secure: process.env.NODE_ENV === "production",
  });

  // 回跳：只允许站内相对路径，防 open redirect；非法/缺省回落 /dashboard。
  redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
}

/**
 * 邮箱自助注册（两步：注册 → 邮箱验证码 → 建号并自动登录）。
 *   - 第一步 registerAction：邮箱 + 密码 → 返回 challengeId（验证码已发到邮箱）
 *   - 第二步 registerVerifyAction：验证码 → 建号 + 签发 ag_session → 跳 /dashboard
 */
export async function registerAction(formData: FormData): Promise<{ error?: string; challengeId?: string }> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "请输入邮箱和密码" };

  const r = await authFetch(`${CLIENT_API_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;

  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; challengeId?: string; error?: { message?: string } }
    | null;

  if (res.ok && body?.challengeId) {
    return { challengeId: body.challengeId };
  }
  return { error: body?.error?.message ?? `注册失败 (${res.status})` };
}

/** 注册第二步：验证邮箱验证码，成功建号+落会话并跳转 */
export async function registerVerifyAction(challengeId: string, code: string): Promise<{ error?: string }> {
  const r = await authFetch(`${CLIENT_API_BASE}/api/auth/register/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId, code }),
    cache: "no-store",
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { error: body?.error?.message ?? `验证失败 (${res.status})` };
  }

  const setCookie = res.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!sessionCookie) {
    return { error: "验证成功但未收到会话 Cookie，请重试" };
  }
  const token = sessionCookie.split(";")[0]!.split("=").slice(1).join("=");

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
    secure: process.env.NODE_ENV === "production",
  });

  redirect("/dashboard");
}

/** 注销 */
export async function logoutAction(): Promise<void> {
  // 通知 client-api 清服务端会话状态（cookie 本身删除即生效，这里 fire-and-forget）
  try {
    await fetch(`${CLIENT_API_BASE}/api/auth/logout`, { method: "POST", cache: "no-store" });
  } catch {
    // 忽略：本地 cookie 删除即注销
  }
  await clearSessionCookie();
  redirect("/login");
}
