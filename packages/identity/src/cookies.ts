/**
 * 会话 Cookie 容器（双身份物理隔离）。
 *
 *   - 用户面（client-api）：ag_session
 *   - 管理面（admin-api）：ag_admin_session
 *
 * 两个 Cookie 名互不重叠：用户浏览器里可以同时持有两份（若同一人既是用户又是管理员，
 * 需要两个账号、两次登录，符合「严格互斥」设计）。
 *
 * HttpOnly + SameSite=Lax + Secure（生产）属性由各登录端点在 setCookie 时统一附加。
 */

/** 用户面会话 Cookie（client-api 签发/读取） */
export const SESSION_COOKIE = 'ag_session';

/** 管理面会话 Cookie（admin-api 签发/读取） */
export const ADMIN_SESSION_COOKIE = 'ag_admin_session';

/** Cookie 安全属性（生产 https 才开 secure） */
export function cookieOptions(secure: boolean, maxAgeSec: number) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSec,
  };
}
