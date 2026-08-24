/**
 * core transport 行为规格(v1 doFetch 首次测试固化;MIGRATION §7 对照清单)。
 * fake fetch 捕获 (url, init),断言头合并顺序、编解码语义与错误信封。
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/core/api-error';
import { createHttpClient, type ApiFetchOptions } from '../src/core/client';

interface CapturedInit {
  method?: string;
  headers: Record<string, string>;
  body?: string;
  cache?: string;
  signal?: AbortSignal;
  next?: { revalidate: number };
}

interface Captured {
  url: string;
  init: CapturedInit;
}

function fakeFetch(status: number, body: string) {
  const calls: Captured[] = [];
  const fn = vi.fn(async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as CapturedInit });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  });
  return { fn, calls };
}

const ok = (body: string) => fakeFetch(200, body);

/** 取第 index 次调用的头对象;缺失即测试自身装配错误,直接抛出 */
function headersAt(calls: Captured[], index: number): Record<string, string> {
  const captured = calls[index];
  if (!captured) throw new Error(`fetch call #${index} not captured`);
  return captured.init.headers;
}

describe('URL 与方法', () => {
  it('GET 缺省:base+path 直拼,method GET,content-type json,cache default', async () => {
    const { fn, calls } = ok('{"a":1}');
    const client = createHttpClient({
      baseUrl: 'http://api.local:8081',
      fetch: fn as unknown as typeof fetch,
    });
    await client.get<{ a: number }>('/v1/me');
    expect(calls[0]?.url).toBe('http://api.local:8081/v1/me');
    expect(calls[0]?.init.method).toBe('GET');
    expect(headersAt(calls, 0)['content-type']).toBe('application/json');
    expect(calls[0]?.init.cache).toBe('default');
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('post/patch/put/delete 便捷方法携带对应动词与 body', async () => {
    const { fn, calls } = ok('{}');
    const client = createHttpClient({ baseUrl: 'http://x', fetch: fn as unknown as typeof fetch });
    await client.post('/v1/keys', { name: 'prod' });
    await client.patch('/v1/keys/1', { status: 1 });
    await client.put('/v1/keys/1', { name: 'a' });
    await client.delete('/v1/keys/1');
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'PATCH', 'PUT', 'DELETE']);
    expect(calls[0]?.init.body).toBe(JSON.stringify({ name: 'prod' }));
  });
});

describe('路径守卫(不做路径翻译)', () => {
  it.each(['/api/keys', 'v1/me', '/v2/me', '/admin/users'])(
    '非 /v1/* 正式路径 %s 抛英文错误',
    async (path) => {
      const client = createHttpClient({
        baseUrl: 'http://x',
        fetch: vi.fn() as unknown as typeof fetch,
      });
      await expect(client.request(path)).rejects.toThrow(
        /\[api-client\] Invalid API path .+; only \/v1\/\* is allowed/,
      );
    },
  );

  it('/v1/ 前缀路径放行(不发请求即可判定的合法形态)', async () => {
    const { fn, calls } = ok('{}');
    const client = createHttpClient({ baseUrl: 'http://x', fetch: fn as unknown as typeof fetch });
    await client.get('/v1/auth/session');
    expect(calls).toHaveLength(1);
  });
});

describe('会话头注入(B1 回归:token 只来自注入的 getToken,无基地址比较)', () => {
  it('getToken 返回 token → authorization: Bearer', async () => {
    const { fn, calls } = ok('{}');
    const client = createHttpClient({
      baseUrl: 'http://x',
      fetch: fn as unknown as typeof fetch,
      getToken: () => 'jwt-token',
    });
    await client.get('/v1/me');
    expect(headersAt(calls, 0).authorization).toBe('Bearer jwt-token');
  });

  it('getToken 异步与空值:Promise token 可等待;null/undefined 不带 authorization', async () => {
    const { fn, calls } = ok('{}');
    const withNull = createHttpClient({
      baseUrl: 'http://x',
      fetch: fn as unknown as typeof fetch,
      getToken: async () => null,
    });
    await withNull.get('/v1/me');
    expect(headersAt(calls, 0).authorization).toBeUndefined();

    const withoutGetter = createHttpClient({
      baseUrl: 'http://x',
      fetch: fn as unknown as typeof fetch,
    });
    await withoutGetter.get('/v1/me');
    expect(headersAt(calls, 1).authorization).toBeUndefined();
  });

  it('bearerToken 覆盖 getToken;显式 null 表示不带会话', async () => {
    const { fn, calls } = ok('{}');
    const client = createHttpClient({
      baseUrl: 'http://x',
      fetch: fn as unknown as typeof fetch,
      getToken: () => 'auto-token',
    });
    await client.get('/v1/me', { bearerToken: 'explicit' });
    await client.get('/v1/me', { bearerToken: null });
    expect(headersAt(calls, 0).authorization).toBe('Bearer explicit');
    expect(headersAt(calls, 1).authorization).toBeUndefined();
  });
});

describe('头合并顺序', () => {
  it('getHeaders 结果并入默认头;调用方 headers 最后覆盖(可覆盖 content-type)', async () => {
    const { fn, calls } = ok('{}');
    const client = createHttpClient({
      baseUrl: 'http://x',
      fetch: fn as unknown as typeof fetch,
      getHeaders: async () => ({ 'accept-language': 'zh', 'x-forwarded-for': '1.2.3.4' }),
    });
    await client.get('/v1/me', { headers: { 'content-type': 'text/plain', 'x-custom': 'c' } });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['accept-language']).toBe('zh');
    expect(headers['x-forwarded-for']).toBe('1.2.3.4');
    expect(headers['content-type']).toBe('text/plain');
    expect(headers['x-custom']).toBe('c');
  });
});

describe('请求体序列化(v1 语义)', () => {
  it.each([
    [{ name: 'prod' }, JSON.stringify({ name: 'prod' })],
    [null, 'null'],
    [[1, 2], '[1,2]'],
  ])('body %o → %s', async (body, expected) => {
    const { fn, calls } = ok('{}');
    const client = createHttpClient({ baseUrl: 'http://x', fetch: fn as unknown as typeof fetch });
    const opts: ApiFetchOptions = { method: 'POST', body };
    await client.request('/v1/keys', opts);
    expect(calls[0]?.init.body).toBe(expected);
  });

  it('body undefined 不发送', async () => {
    const { fn, calls } = ok('{}');
    const client = createHttpClient({ baseUrl: 'http://x', fetch: fn as unknown as typeof fetch });
    await client.request('/v1/keys', { method: 'POST' });
    expect(calls[0]?.init.body).toBeUndefined();
  });
});

describe('缓存提示透传(v1 语义)', () => {
  it('revalidate: false → cache no-store;number → cache default + next.revalidate 透传', async () => {
    const { fn, calls } = ok('{}');
    const client = createHttpClient({ baseUrl: 'http://x', fetch: fn as unknown as typeof fetch });
    await client.get('/v1/me', { revalidate: false });
    await client.get('/v1/me', { revalidate: 60 });
    expect(calls[0]?.init.cache).toBe('no-store');
    expect(calls[0]?.init.next).toBeUndefined();
    expect(calls[1]?.init.cache).toBe('default');
    expect(calls[1]?.init.next).toEqual({ revalidate: 60 });
  });

  it('RequestInit 其余字段透传(signal)', async () => {
    const { fn, calls } = ok('{}');
    const client = createHttpClient({ baseUrl: 'http://x', fetch: fn as unknown as typeof fetch });
    const controller = new AbortController();
    await client.get('/v1/me', { signal: controller.signal });
    expect(calls[0]?.init.signal).toBe(controller.signal);
  });
});

describe('响应编解码(v1 语义)', () => {
  it('JSON 响应解析为对象', async () => {
    const { fn } = ok('{"rows":[],"total":0}');
    const client = createHttpClient({ baseUrl: 'http://x', fetch: fn as unknown as typeof fetch });
    await expect(client.get('/v1/keys')).resolves.toEqual({ rows: [], total: 0 });
  });

  it('空响应体 → null;非 JSON 体 → { raw: text }', async () => {
    const empty = fakeFetch(200, '');
    const client1 = createHttpClient({
      baseUrl: 'http://x',
      fetch: empty.fn as unknown as typeof fetch,
    });
    await expect(client1.get('/v1/me')).resolves.toBeNull();

    const text = fakeFetch(200, 'plain text');
    const client2 = createHttpClient({
      baseUrl: 'http://x',
      fetch: text.fn as unknown as typeof fetch,
    });
    await expect(client2.get('/v1/me')).resolves.toEqual({ raw: 'plain text' });
  });
});

describe('错误信封 → ApiError(铁律 18:兜底 message 英文)', () => {
  it('统一错误信封三字段完整映射', async () => {
    const { fn } = fakeFetch(
      409,
      JSON.stringify({
        error: {
          message: 'duplicated name',
          code: 'key.name.duplicated',
          details: { field: 'name' },
        },
      }),
    );
    const client = createHttpClient({ baseUrl: 'http://x', fetch: fn as unknown as typeof fetch });
    const err = await client
      .request('/v1/keys', { method: 'POST', body: {} })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    const apiError = err as ApiError;
    expect(apiError.name).toBe('ApiError');
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe('key.name.duplicated');
    expect(apiError.message).toBe('duplicated name');
    expect(apiError.details).toEqual({ field: 'name' });
  });

  it('信封缺 message / 非 JSON 错误体 → 英文兜底 Request failed (status)', async () => {
    const noMessage = fakeFetch(400, JSON.stringify({ error: { code: 'bad' } }));
    const client1 = createHttpClient({
      baseUrl: 'http://x',
      fetch: noMessage.fn as unknown as typeof fetch,
    });
    await expect(client1.get('/v1/me')).rejects.toThrow('Request failed (400)');

    const plain = fakeFetch(502, 'Bad Gateway');
    const client2 = createHttpClient({
      baseUrl: 'http://x',
      fetch: plain.fn as unknown as typeof fetch,
    });
    await expect(client2.get('/v1/me')).rejects.toThrow('Request failed (502)');
    await expect(client2.get('/v1/me')).rejects.toMatchObject({ status: 502, code: undefined });
  });
});

describe('list():分页查询构造 + 信封解析', () => {
  it('查询串 page/limit 追加到 path,返回 Paginated 信封', async () => {
    const { fn, calls } = ok(JSON.stringify({ rows: [{ id: 1 }], total: 1, page: 2, limit: 10 }));
    const client = createHttpClient({ baseUrl: 'http://x', fetch: fn as unknown as typeof fetch });
    const data = await client.list<{ id: number }>('/v1/keys', { page: 2, pageSize: 10 });
    expect(calls[0]?.url).toBe('http://x/v1/keys?page=2&limit=10');
    expect(data).toEqual({ rows: [{ id: 1 }], total: 1, page: 2, limit: 10 });
  });
});
