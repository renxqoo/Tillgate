/**
 * 服务端会话工具(Server Component / Server Action 用;仅 ./next 子入口导出)。
 *
 * 后端是无 Cookie 的 Bearer 会话:JWT 由本 BFF(Next.js 服务端)持有——
 * 登录/验码动作从响应体取 token,写入自己的 HttpOnly Cookie(沿用 ag_session /
 * ag_admin_session 名字,浏览器侧行为不变);发往后端时改以
 * Authorization: Bearer 头携带(由 clients.ts 装配的 getToken 注入)。
 */
import { cookies } from 'next/headers';

/** 用户面会话 cookie name(BFF 持有 client-api 的 Bearer JWT) */
export const SESSION_COOKIE = 'ag_session';
/** 管理面会话 cookie name(BFF 持有 admin-api 的 Bearer JWT) */
export const ADMIN_SESSION_COOKIE = 'ag_admin_session';

const SESSION_TTL_S = Number(process.env.SESSION_TTL_SECONDS ?? 86_400);

/** 读用户面 Bearer token(cookie 值即 JWT;无会话返回 null) */
export async function getSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

/** 读管理面 Bearer token */
export async function getAdminSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ADMIN_SESSION_COOKIE)?.value ?? null;
}

/** 写用户面会话(登录/验码成功后由 Server Action 调用;token 来自响应体) */
export async function setSessionToken(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_S,
  });
}

/** 写管理面会话 */
export async function setAdminSessionToken(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_S,
  });
}

/** 当前是否有用户面会话 cookie */
export async function hasSessionCookie(): Promise<boolean> {
  const jar = await cookies();
  return jar.has(SESSION_COOKIE);
}

/** 当前是否有管理面会话 cookie */
export async function hasAdminSessionCookie(): Promise<boolean> {
  const jar = await cookies();
  return jar.has(ADMIN_SESSION_COOKIE);
}

/** 清空用户面会话(注销;Bearer 无服务端态——清本地即下线) */
export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/** 清空管理面会话 */
export async function clearAdminSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(ADMIN_SESSION_COOKIE);
}
