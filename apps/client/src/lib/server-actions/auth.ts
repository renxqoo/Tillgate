"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { clearSessionCookie, SESSION_COOKIE } from "@ai-gateway/api-client";

const CLIENT_API_BASE = process.env.CLIENT_API_BASE ?? "http://localhost:8791";
const SESSION_TTL_S = 24 * 60 * 60;

/**
 * 用户登录 Server Action（client-api 用户面）。
 *   - 调用 client-api /api/auth/login（用户登录端点，与 admin-api 管理员登录隔离）
 *   - 把返回的 ag_session cookie 复制到 Next.js 的 Cookie 容器（同域 HttpOnly）
 *   - 成功跳 /dashboard
 */
export async function loginAction(formData: FormData): Promise<{ error?: string }> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!username || !password) return { error: "请输入用户名和密码" };

  const res = await fetch(`${CLIENT_API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string; code?: string } }
      | null;
    return {
      error: body?.error?.message ?? `登录失败 (${res.status})`,
    };
  }

  const setCookie = res.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!sessionCookie) {
    return { error: "登录成功但未收到会话 Cookie，请重试" };
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
