/**
 * admin-api 客户端封装（服务端用，next.config 代理或直连内网）。
 *
 * 控制台是 Next.js 服务端渲染：所有 admin-api 调用在 Server Component / Route Handler / Server Action 中进行，
 * 凭证通过 HttpOnly Cookie 自动携带（同域，浏览器自动发 Cookie）。
 *
 * ADMIN_API_BASE：admin-api 内网地址（默认 http://localhost:8790，由环境变量覆盖）。
 */
const ADMIN_API_BASE = process.env.ADMIN_API_BASE ?? 'http://localhost:8790';

export interface ApiError {
  message: string;
  code?: string;
  details?: unknown;
}

/**
 * 调用 admin-api（服务端）。
 *   - cookieHeader：透传浏览器 Cookie（会话 JWT 在 HttpOnly Cookie 中）
 *   - 失败抛 ApiError，调用方 try-catch
 */
export async function apiFetch<T>(
  path: string,
  opts: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    cookieHeader?: string | null;
    revalidate?: number;
  } = {},
): Promise<T> {
  const { method = 'GET', body, cookieHeader, revalidate } = opts;
  const res = await fetch(`${ADMIN_API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: revalidate !== undefined ? 'default' : 'no-store',
    next: revalidate !== undefined ? { revalidate } : undefined,
  });
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
    const err = (data as { error?: ApiError } | null)?.error;
    throw { message: err?.message ?? `请求失败 (${res.status})`, code: err?.code, status: res.status, details: err?.details } as ApiError & { status: number };
  }
  return data as T;
}

/** 从请求头取 Cookie（Server Component 中用） */
export function getCookieHeader(headers: Headers): string {
  return headers.get('cookie') ?? '';
}

/**
 * 格式化金额展示（DB 现存「元」numeric 字符串，如 "49.999990000000000000"）。
 * 余额/流水用 2 位小数；单次费用用 6 位（小额请求精确展示）。
 * 入参兼容 string（DB numeric）/ number（历史/兜底）。
 */
export function formatYuan(v: string | number | null | undefined, digits = 2): string {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(digits);
}

/** 余额/流水展示（2 位小数） */
export function fmtBalance(v: string | number | null | undefined): string {
  return formatYuan(v, 2);
}

/** 单次费用展示（6 位小数，小额请求精确到 ¥0.000001） */
export function fmtCost(v: string | number | null | undefined): string {
  return formatYuan(v, 6);
}

/** 模型单价展示（元/百万 token，4 位小数） */
export function fmtPrice(v: string | number | null | undefined): string {
  return formatYuan(v, 4);
}

/** 毫秒 → 友好展示：<1s 显示 ms，≥1s 显示秒（保留 2 位） */
export function msToHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 标准分页响应 */
export interface Paginated<T> {
  list: T[];
  total: number;
  page: number;
  page_size: number;
}

/** 当前用户信息 */
export interface MeInfo {
  id: number;
  subject: string;
  email: string | null;
  displayName: string | null;
  role: number;
  rateCardId: number | null;
  rateCardName: string | null;
  balance: string;
  status: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  lastLoginAt: string | null;
  createdAt: string;
}

/** 检查是否已登录（调用 /api/me，失败返回 null） */
export async function getMe(cookieHeader: string | null): Promise<MeInfo | null> {
  try {
    return await apiFetch<MeInfo>('/api/me', { cookieHeader });
  } catch {
    return null;
  }
}
