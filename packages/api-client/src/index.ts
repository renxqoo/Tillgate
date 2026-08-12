/**
 * client-api / admin-api 调用封装（服务端用）。
 *
 * 控制台是 Next.js 服务端渲染：所有 api 调用在 Server Component / Server Action 里发生。
 * 会话通过 HttpOnly Cookie 自动携带（同域，Next.js 用 cookies() 转发到 fetch 的 cookie 头）。
 *
 * 双后端（admin-api 拆分后）：
 *   - client-api（用户面，端口 8791）：/api/me、/api/keys、/api/apps、/api/usage、/api/redeem、/api/auth/*
 *     会话 Cookie：ag_session（JWT_SECRET 签发，type='user'）
 *   - admin-api（管理面，端口 8790）：/api/admin/*（含 /api/admin/auth/*、/api/admin/me）
 *     会话 Cookie：ag_admin_session（ADMIN_JWT_SECRET 签发，type='admin'）
 *
 * 两个 base + 两个 cookie，物理隔离。apps/client 用 apiFetch（client base），
 * apps/admin 用 adminFetch（admin base）。
 */
import { getCookieHeader as _readCookieHeader } from './session';

/** client-api（用户面）内网地址 */
const CLIENT_API_BASE = process.env.CLIENT_API_BASE ?? 'http://localhost:8791';
/** admin-api（管理面）内网地址 */
const ADMIN_API_BASE = process.env.ADMIN_API_BASE ?? 'http://localhost:8790';

export const ADMIN_API_BASE_URL = ADMIN_API_BASE;
export const CLIENT_API_BASE_URL = CLIENT_API_BASE;

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;
  public readonly details: unknown;
  constructor(status: number, code: string | undefined, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  /** 不传就自动从 next/headers 读 cookie */
  cookieHeader?: string | null;
  /** Next.js 缓存提示 */
  revalidate?: number | false;
}

/**
 * 内部通用 fetch：注入 base，转发 cookie。
 */
async function doFetch<T>(
  base: string,
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const { method = 'GET', body, cookieHeader, revalidate, headers: extraHeaders, ...rest } = opts;
  const cookie = cookieHeader ?? (await _readCookieHeader());

  const res = await fetch(`${base}${path}`, {
    method,
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(extraHeaders ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: revalidate === false ? 'no-store' : 'default',
    // Next.js 专有扩展（Node fetch 类型不识别），绕过类型检查
    ...(typeof revalidate === 'number' ? { next: { revalidate } } : {}),
  } as unknown as RequestInit);

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string; details?: unknown } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code,
      err?.message ?? `请求失败 (${res.status})`,
      err?.details,
    );
  }
  return data as T;
}

/**
 * 调用 client-api（用户面）。apps/client 用。
 *   - cookieHeader: 透传浏览器 Cookie（ag_session 会话 JWT 在 HttpOnly Cookie 中）
 *   - 失败抛 ApiError，调用方 try-catch
 */
export async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  return doFetch<T>(CLIENT_API_BASE, path, opts);
}

/**
 * 调用 admin-api（管理面）。apps/admin 用。
 *   - cookieHeader: 透传浏览器 Cookie（ag_admin_session 会话 JWT 在 HttpOnly Cookie 中）
 *   - 失败抛 ApiError，调用方 try-catch
 */
export async function adminFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  return doFetch<T>(ADMIN_API_BASE, path, opts);
}

// 重新导出
export * from './types';
export * from './formatters';
export * from './session';

// session cookie（双面）
export {
  getCookieHeader,
  hasSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
  hasAdminSessionCookie,
  clearAdminSessionCookie,
  ADMIN_SESSION_COOKIE,
} from './session';

/**
 * 调用 client-api 的 /api/me，失败返回 null（用于 apps/client 的 layout 守卫）。
 */
export async function getMe(): Promise<import('./types').MeInfo | null> {
  try {
    return await apiFetch<import('./types').MeInfo>('/api/me');
  } catch {
    return null;
  }
}

/**
 * 调用 admin-api 的 /api/admin/me，失败返回 null（用于 apps/admin 的 layout 守卫）。
 * 能拿到即证明持有效管理员会话（admin-api 已用 adminAuthMiddleware 守护）。
 */
export async function getAdminMe(): Promise<import('./types').AdminMeInfo | null> {
  try {
    return await adminFetch<import('./types').AdminMeInfo>('/api/admin/me');
  } catch {
    return null;
  }
}
