'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

const ADMIN_API_BASE = process.env.ADMIN_API_BASE ?? 'http://localhost:8790';
const SESSION_COOKIE = 'ag_session';
const SESSION_TTL_S = 24 * 60 * 60;

/**
 * 登录 Server Action（api-contract §4.1）。
 * 调用 admin-api /api/auth/login，成功后把会话 Cookie 设到浏览器（同域 HttpOnly）。
 */
export async function loginAction(formData: FormData): Promise<{ error?: string }> {
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');
  if (!username || !password) return { error: '请输入用户名和密码' };

  const res = await fetch(`${ADMIN_API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { error: body?.error?.message ?? '登录失败' };
  }
  // 从 admin-api 响应提取 Set-Cookie 中的 ag_session 值，用 next/headers 的 cookies() 重新设置
  // （同域 HttpOnly，让后续 Server Component 的 fetch 自动携带）
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookie.find((c) => c.startsWith('ag_session='));
  if (sessionCookie) {
    const token = sessionCookie.split(';')[0]!.split('=').slice(1).join('=');
    const jar = await cookies();
    jar.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_S,
      secure: process.env.NODE_ENV === 'production',
    });
  }
  redirect('/dashboard');
}

/** 注销 Server Action：清浏览器 Cookie */
export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect('/');
}
