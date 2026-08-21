/**
 * client-api / admin-api 调用封装（服务端用）。
 *
 * 控制台是 Next.js 服务端渲染：所有 api 调用在 Server Component / Server Action 里发生。
 * 后端是无 Cookie 的 Bearer 会话——JWT 由 BFF 持有（session.ts 的 HttpOnly Cookie），
 * 本层发请求时以 Authorization: Bearer 携带。
 *
 * 双后端物理隔离：
 *   - client-api（用户面，端口 8081）：/v1/me、/v1/keys、/v1/apps、/v1/usage、
 *     /v1/redeem、/v1/auth/*、/v1/wallet/*、/v1/subscriptions、/v1/orgs、/v1/payments
 *   - admin-api（管理面，端口 8082）：/v1/providers、/v1/channels、/v1/models、
 *     /v1/users、/v1/plans、/v1/channel-funds、/v1/billing-operations、/v1/tracing 等
 *
 * 调用方必须传后端唯一正式路径 /v1/*；本层不做路径翻译。
 */
import { cookies, headers } from 'next/headers';

import { trustedClientIp } from '@ai-gateway/http/network';

import { LOCALE_COOKIE, resolveLocale, type Locale } from './i18n';
import { getAdminSessionToken, getSessionToken } from './session';

/**
 * BFF 透传真实用户 IP：client-api / admin-api 不在 nginx 后（Next 服务端直连），
 * 没有 XFF 转发时它们的按 IP 爆破锁会把所有用户记成同一个 Next 容器 IP。
 * 链路：浏览器 → nginx(XFF 追加真实 IP) → Next（本层按 TRUSTED_PROXY_HOPS 解出）
 *      → API（XFF: <用户 IP>，API 侧同样 hops=1 采信右数第 1 跳）。
 * 解不出（dev 直连 hops=0 / 非请求上下文如构建期）→ 不带该头，API 回落 socket。
 */
async function outgoingUserIpHeader(): Promise<Record<string, string>> {
  try {
    const ip = trustedClientIp({
      headers: await headers(),
      trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 0) || 0,
      socketAddress: null,
    });
    return ip.startsWith('unknown-') ? {} : { 'x-forwarded-for': ip };
  } catch {
    return {}; // 非请求上下文（SSG 构建等）：无入站请求头可解
  }
}

/**
 * BFF 出口语言：与 UI 同源（cookie NEXT_LOCALE → 浏览器 Accept-Language → 默认英文），
 * 注入 accept-language 让 API 错误 message 语言与界面一致。非请求上下文回落英文。
 */
/** UI 生效语言（cookie → 浏览器头 → en）；list.ts 等服务端兜底文案复用 */
export async function outgoingLocale(): Promise<Locale> {
  try {
    const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
    return resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get('accept-language'));
  } catch {
    return 'en'; // 非请求上下文（SSG 构建等）
  }
}

/**
 * API 基地址解析：显式 env 优先，缺省回落本地 dev 端口（bun dev 直跑开箱即用）。
 * 生产安全不依赖兜底——compose 部署由 console 容器 environment 段显式注入
 * 容器网络地址；仅当「生产既未注入又直跑前端」时才会指到 localhost 并以
 * 连接失败显式暴露，不会静默串数据。
 */
function baseOrDefault(name: 'CLIENT_API_BASE' | 'ADMIN_API_BASE', devBase: string): string {
  return process.env[name] || devBase;
}
// 惰性解析（首次调用时才要求配置）：用户面前端不引用 ADMIN_API_BASE（反之亦然），
// 模块加载期不因未用到的基地址缺失而炸（Next 构建期 collect page data 会加载模块）
const getClientBase = () => (CLIENT_API_BASE ??= baseOrDefault('CLIENT_API_BASE', 'http://localhost:8081'));
let CLIENT_API_BASE: string | null = null;
/** admin-api（管理面）内网地址 */
const getAdminBase = () => (ADMIN_API_BASE ??= baseOrDefault('ADMIN_API_BASE', 'http://localhost:8082'));
let ADMIN_API_BASE: string | null = null;

export const ADMIN_API_BASE_URL = { valueOf: () => getAdminBase(), toString: () => getAdminBase() } as unknown as string;
export const CLIENT_API_BASE_URL = { valueOf: () => getClientBase(), toString: () => getClientBase() } as unknown as string;

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
  /** 显式指定 Bearer token（缺省自动读会话 cookie） */
  bearerToken?: string | null;
  /** Next.js 缓存提示 */
  revalidate?: number | false;
}

/**
 * 内部通用 fetch：注入 base + Bearer 会话头。
 */
const isAdminBase = (base: string): boolean => base === (ADMIN_API_BASE ?? undefined);

async function doFetch<T>(base: string, path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const { method = 'GET', body, bearerToken, revalidate, headers: extraHeaders, ...rest } = opts;
  const token =
    bearerToken !== undefined ? bearerToken : isAdminBase(base) ? await getAdminSessionToken() : await getSessionToken();
  const locale = await outgoingLocale();

  if (!path.startsWith('/v1/')) {
    throw new Error(`[api-client] Invalid API path ${path}; only /v1/* is allowed`);
  }
  const res = await fetch(`${base}${path}`, {
    method,
    ...rest,
    headers: {
      'content-type': 'application/json',
      'accept-language': locale,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(await outgoingUserIpHeader()),
      ...extraHeaders,
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
    const err = (data as { error?: { message?: string; code?: string; details?: unknown } } | null)
      ?.error;
    throw new ApiError(
      res.status,
      err?.code,
      err?.message ?? (locale === 'zh' ? `请求失败 (${res.status})` : `Request failed (${res.status})`),
      err?.details,
    );
  }
  return data as T;
}

/**
 * 调用 client-api（用户面）。Bearer 自动携带；失败抛 ApiError。
 */
export async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  return doFetch<T>(getClientBase(), path, opts);
}

/**
 * 调用 admin-api（管理面）。Bearer 自动携带；失败抛 ApiError。
 */
export async function adminFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  return doFetch<T>(getAdminBase(), path, opts);
}

// 重新导出
export * from './types';
export * from './formatters';
export * from './session';

// session cookie（双面）
export {
  hasSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
  hasAdminSessionCookie,
  clearAdminSessionCookie,
  ADMIN_SESSION_COOKIE,
  getSessionToken,
  setSessionToken,
  getAdminSessionToken,
  setAdminSessionToken,
} from './session';

/**
 * 调用 client-api 的 /v1/me，失败返回 null（用于 apps/client 的 layout 守卫）。
 */
export async function getMe(): Promise<import('./types').MeInfo | null> {
  try {
    return await apiFetch<import('./types').MeInfo>('/v1/me');
  } catch {
    return null;
  }
}

/**
 * 调用 admin-api 的 /v1/me，失败返回 null（用于 apps/admin 的 layout 守卫）。
 * 能拿到即证明持有效管理员会话（admin-api 已用 adminAuthMiddleware 守护）。
 */
export async function getAdminMe(): Promise<import('./types').AdminMeInfo | null> {
  try {
    return await adminFetch<import('./types').AdminMeInfo>('/v1/me');
  } catch {
    return null;
  }
}
