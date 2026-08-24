/**
 * server action 测试公共装置（vitest node 环境）：
 * next/headers 的 cookie jar、next/cache、next/navigation、next-intl 与
 * globalThis.fetch 全部桩化——被测面是 wire 调用形状与 {error} 信封语义。
 */
import { vi } from 'vitest';

import { defined } from './defined';

/** cookie jar 桩（Map 形态；api-client session 语义：get/set/delete/has） */
export function mockCookieJar(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const jar = {
    get: (key: string) =>
      store.has(key) ? { value: defined(store.get(key), 'cookie') } : undefined,
    set: (key: string, value: string) => void store.set(key, value),
    delete: (key: string) => void store.delete(key),
    has: (key: string) => store.has(key),
  };
  return { jar, store };
}

export interface FetchCall {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** fetch 桩：按序回放 responses；记录每次调用（wire 断言面） */
export interface MockResponse {
  status?: number;
  body?: unknown;
  /** 模拟网络层异常（fetch reject——非 ApiError 分支） */
  throwError?: boolean;
}

export function mockFetch(responses: MockResponse[]) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const raw = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(raw)) headers[k] = v;
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
      headers,
    });
    const next = queue.shift() ?? { status: 200, body: {} };
    if (next.throwError) throw new Error('network down');
    const status = next.status ?? 200;
    const text = JSON.stringify(next.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return next.body ?? {};
      },
      async text() {
        return text;
      },
    } as unknown as Response;
  });
  return { fetchStub, calls };
}

/** 统一安装 next 运行时桩（每测试重装） */
export function installNextStubs(opts: { jar?: ReturnType<typeof mockCookieJar>['jar'] } = {}) {
  const { jar } = mockCookieJar({ ...(opts.jar ? undefined : {}) });
  const useJar = opts.jar ?? jar;

  vi.doMock('next/headers', () => ({
    cookies: async () => useJar,
    headers: async () => new Map([['accept-language', 'en']]),
  }));
  vi.doMock('next/cache', () => ({ revalidatePath: () => {} }));
  const redirectCalls: string[] = [];
  vi.doMock('next/navigation', () => ({
    redirect: (path: string) => {
      redirectCalls.push(path);
      throw Object.assign(new Error(`redirect:${path}`), { __redirect: path });
    },
  }));
  vi.doMock('next-intl/server', () => ({
    getTranslations: async () =>
      ((key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key) as never,
    getLocale: async () => 'en',
  }));
  return { redirectCalls };
}
