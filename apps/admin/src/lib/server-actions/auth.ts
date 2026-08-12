"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { clearAdminSessionCookie, ADMIN_SESSION_COOKIE } from "@ai-gateway/api-client";

const ADMIN_API_BASE = process.env.ADMIN_API_BASE ?? "http://localhost:8790";
const SESSION_TTL_S = 24 * 60 * 60;

/**
 * 管理员登录（admin-api 专用端点，与用户面物理隔离）。
 *   - 端点：POST /api/admin/auth/login（admin-api 独有，非用户面 /api/auth/login）
 *   - 凭证：email + password（管理员账号是 email，非 username）
 *   - 会话：ag_admin_session cookie（ADMIN_JWT_SECRET 签发，type='admin'）
 */
export async function loginAction(formData: FormData): Promise<{ error?: string }> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "请输入邮箱和密码" };

  const res = await fetch(`${ADMIN_API_BASE}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    return { error: body?.error?.message ?? `登录失败 (${res.status})` };
  }

  const setCookie = res.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  if (!sessionCookie) return { error: "登录成功但未收到会话 Cookie" };

  const token = sessionCookie.split(";")[0]!.split("=").slice(1).join("=");
  const jar = await cookies();
  jar.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
    secure: process.env.NODE_ENV === "production",
  });

  redirect("/dashboard");
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
