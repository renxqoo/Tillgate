"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { clearAdminSessionCookie, ADMIN_SESSION_COOKIE } from "@ai-gateway/api-client";

const ADMIN_API_BASE = process.env.ADMIN_API_BASE ?? "http://localhost:8790";
const SESSION_TTL_S = 24 * 60 * 60;

/**
 * auth API fetch 兜底：API 不可达（fetch 抛错）时返回结构化 error。
 * server action 以异常 reject 会在客户端变成无提示的失败（无 toast，
 * 只有 console 错误）——登录失败必须有可见反馈。
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
 * 管理员登录（admin-api 专用端点，与用户面物理隔离）。
 *   - 端点：POST /api/admin/auth/login（admin-api 独有，非用户面 /api/auth/login）
 *   - 凭证：email + password（管理员账号是 email，非 username）
 *   - 会话：ag_admin_session cookie（ADMIN_JWT_SECRET 签发，type='admin'）
 */
export async function loginAction(formData: FormData): Promise<{ error?: string; challengeId?: string }> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "请输入邮箱和密码" };

  const r = await authFetch(`${ADMIN_API_BASE}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  if (isFetchError(r)) return { error: r.fetchError };
  const res: Response = r;

  const body = (await res.json().catch(() => null)) as
    | { error?: { message?: string }; twoFactorRequired?: boolean; challengeId?: string }
    | null;

  if (!res.ok) {
    return { error: body?.error?.message ?? `登录失败 (${res.status})` };
  }

  // 两步登录（邮箱验证码）：第一步成功但需要验证码——进入第二步
  if (body?.twoFactorRequired && body.challengeId) {
    return { challengeId: body.challengeId };
  }

  await setSessionFromResponse(res);
  redirect("/dashboard");
}

/** 第二步：提交邮箱验证码完成登录 */
export async function verifyLoginAction(challengeId: string, code: string): Promise<{ error?: string }> {
  if (!/^\d{6}$/.test(code)) return { error: "请输入 6 位数字验证码" };
  const r = await authFetch(`${ADMIN_API_BASE}/api/admin/auth/login/verify`, {
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
  await setSessionFromResponse(res);
  redirect("/dashboard");
}

async function setSessionFromResponse(res: Response): Promise<void> {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  if (!sessionCookie) throw new Error("登录成功但未收到会话 Cookie");

  const token = sessionCookie.split(";")[0]!.split("=").slice(1).join("=");
  const jar = await cookies();
  jar.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
    secure: process.env.NODE_ENV === "production",
  });
}

/** 邮箱验证码二次登录开关（设置页） */
export async function setTwoFactorAction(enabled: boolean): Promise<{ error?: string }> {
  const jar = await cookies();
  const token = jar.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return { error: "未登录" };
  const res = await fetch(`${ADMIN_API_BASE}/api/admin/auth/two-factor`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
      ...(process.env.INTERNAL_API_TOKEN ? { "x-internal-token": process.env.INTERNAL_API_TOKEN } : {}),
    },
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

export async function logoutAction(): Promise<void> {
  // 通知 admin-api 清服务端会话状态（可选：cookie 本身删除即生效，这里 fire-and-forget）
  try {
    await fetch(`${ADMIN_API_BASE}/api/admin/auth/logout`, { method: "POST", cache: "no-store" });
  } catch {
    // 忽略：本地 cookie 删除即注销
  }
  await clearAdminSessionCookie();
  redirect("/login");
}
