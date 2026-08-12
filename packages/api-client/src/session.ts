/**
 * 服务端会话工具（Server Component / Server Action 用）。
 *
 * 双后端（admin-api 拆分后）两个 Cookie 物理隔离：
 *   - 用户面：ag_session（client-api 签发，JWT_SECRET，type='user'）
 *   - 管理面：ag_admin_session（admin-api 签发，ADMIN_JWT_SECRET，type='admin'）
 *
 * 浏览器自动在同域请求中带 HttpOnly Cookie；我们在 server 转发到对应 api 时
 * 手动把 Cookie 头复制过去（getCookieHeader 转发全部 cookie，两个 cookie 都带上，
 * 后端各只认自己的）。
 */
import { cookies, headers } from 'next/headers';

/** 用户面会话 cookie name（client-api） */
export const SESSION_COOKIE = 'ag_session';
/** 管理面会话 cookie name（admin-api） */
export const ADMIN_SESSION_COOKIE = 'ag_admin_session';

/** 从 Next.js 的请求中读出原始 Cookie 字符串（用于转发到 client-api/admin-api） */
export async function getCookieHeader(): Promise<string> {
  // Next.js 16+：cookies() 自身能拿到当前请求的 cookie
  const jar = await cookies();
  const all = jar.getAll();
  if (all.length > 0) {
    return all.map((c) => `${c.name}=${c.value}`).join('; ');
  }
  // fallback：直接从 headers 读
  const reqHeaders = await headers();
  return reqHeaders.get('cookie') ?? '';
}

/** 当前是否有用户面会话 cookie（ag_session） */
export async function hasSessionCookie(): Promise<boolean> {
  const jar = await cookies();
  return jar.has(SESSION_COOKIE);
}

/** 当前是否有管理面会话 cookie（ag_admin_session） */
export async function hasAdminSessionCookie(): Promise<boolean> {
  const jar = await cookies();
  return jar.has(ADMIN_SESSION_COOKIE);
}

/** 清空用户面会话（用于注销，apps/client 用） */
export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/** 清空管理面会话（用于注销，apps/admin 用） */
export async function clearAdminSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(ADMIN_SESSION_COOKIE);
}
