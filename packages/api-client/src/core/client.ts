/**
 * 框架无关 HTTP transport(总纲 §7.2):baseUrl/fetch/token/headers 获取器全部经参数注入,
 * 本模块不读 Next Cookie、不读环境变量、不持有可信代理配置。
 *
 * 行为口径(v1 doFetch 行为等价,见 MIGRATION §7):
 *   - 只接受后端唯一正式路径 /v1/*;本层不做路径翻译
 *   - 默认头 content-type: application/json;getHeaders() 结果与调用方 headers 依次覆盖
 *   - body !== undefined 才 JSON.stringify(null 也发 "null");响应空体→null,非 JSON→{raw}
 *   - 非 2xx 抛 ApiError,字段取自统一错误信封 { error: { message, code, details } }
 *   - revalidate: false → cache:'no-store';number → next.revalidate 透传(见下方注释)
 */
import { ApiError } from './api-error';
import { buildListQuery, type ListFetchOptions, type Paginated } from './pagination';

export interface ApiFetchOptions extends Omit<RequestInit, 'body' | 'headers'> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  /** 显式指定 Bearer token(缺省走注入的 getToken;null 表示不带会话) */
  bearerToken?: string | null;
  /** Next.js 缓存提示:false → cache:'no-store';number → next.revalidate */
  revalidate?: number | false;
  /** 覆盖层:最后合并,可覆盖默认头 */
  headers?: Record<string, string>;
}

/** token/headers 获取器:同步或异步皆可 */
export type HeaderGetter = () =>
  | Record<string, string>
  | undefined
  | Promise<Record<string, string> | undefined>;
export type TokenGetter = () => string | null | undefined | Promise<string | null | undefined>;

export interface HttpClientOptions {
  /** 后端基地址;必填,不藏默认(铁律 3;dev 兜底在 ./next/clients.ts 装配层) */
  baseUrl: string;
  /** fetch 实现;缺省 globalThis.fetch */
  fetch?: typeof globalThis.fetch;
  /** Bearer token 获取器;返回空值则不带 authorization */
  getToken?: TokenGetter;
  /** 出站附加头获取器(accept-language / x-forwarded-for 等) */
  getHeaders?: HeaderGetter;
}

export interface HttpClient {
  request<T>(path: string, opts?: ApiFetchOptions): Promise<T>;
  get<T>(path: string, opts?: ApiFetchOptions): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: ApiFetchOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, opts?: ApiFetchOptions): Promise<T>;
  put<T>(path: string, body?: unknown, opts?: ApiFetchOptions): Promise<T>;
  delete<T>(path: string, opts?: ApiFetchOptions): Promise<T>;
  /** 列表请求:?page=&limit= 查询构造 + Paginated 信封解析;失败抛 ApiError */
  list<T>(path: string, opts: ListFetchOptions): Promise<Paginated<T>>;
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const baseUrl = options.baseUrl;
  const doFetch: typeof globalThis.fetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
    const { method = 'GET', body, bearerToken, revalidate, headers: extraHeaders, ...rest } = opts;

    if (!path.startsWith('/v1/')) {
      throw new Error(`[api-client] Invalid API path ${path}; only /v1/* is allowed`);
    }

    let token: string | null | undefined;
    if (bearerToken !== undefined) {
      // `null` is an explicit per-request opt-out and must not fall back to getToken.
      token = bearerToken;
    } else {
      token = await options.getToken?.();
    }

    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      ...rest,
      headers: {
        'content-type': 'application/json',
        ...((await options.getHeaders?.()) ?? undefined),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: revalidate === false ? 'no-store' : 'default',
      // Next.js 专有扩展(标准 fetch 忽略该字段,Next patched fetch 消费)——惰性透传,
      // core 不 import next(DESIGN §3.5)
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
      const err = (
        data as { error?: { message?: string; code?: string; details?: unknown } } | null
      )?.error;
      // 铁律 18:抛出 message 一律英文;本地化渲染归消费方
      throw new ApiError(
        res.status,
        err?.code,
        err?.message ?? `Request failed (${res.status})`,
        err?.details,
      );
    }
    return data as T;
  }

  return {
    request,
    get: <T>(path: string, opts?: ApiFetchOptions) => request<T>(path, opts),
    post: <T>(path: string, body?: unknown, opts?: ApiFetchOptions) =>
      request<T>(path, { ...opts, method: 'POST', body }),
    patch: <T>(path: string, body?: unknown, opts?: ApiFetchOptions) =>
      request<T>(path, { ...opts, method: 'PATCH', body }),
    put: <T>(path: string, body?: unknown, opts?: ApiFetchOptions) =>
      request<T>(path, { ...opts, method: 'PUT', body }),
    delete: <T>(path: string, opts?: ApiFetchOptions) =>
      request<T>(path, { ...opts, method: 'DELETE' }),
    list: <T>(path: string, opts: ListFetchOptions) =>
      request<Paginated<T>>(`${path}?${buildListQuery(opts)}`),
  };
}
