import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bodyParserLimit, corsPreflight, securityHeaders } from '../src/security/protocol';

/**
 * 协议安全三件套（v1 三拷贝无包级测试——D2 合一后新写行为锁，B2-B4 修正面）：
 * 统一安全头 4 头全集、CORS 策略参数化（白名单外静默放行、预检 204）、
 * bodyLimit 双路径（声明长度快路径 + 实际流计数）413 经单一渲染路径。
 */

function app(): Hono {
  const a = new Hono();
  a.use('*', securityHeaders);
  a.use('*', corsPreflight({ origins: ['https://console.example.com'] }));
  a.use('*', bodyParserLimit(64));
  a.post('/echo', async (c) => c.text(`len:${(await c.req.text()).length}`));
  a.get('/ping', (c) => c.text('pong'));
  return a;
}

describe('securityHeaders（统一 4 头全集）', () => {
  it('响应携带 nosniff / DENY / no-referrer / no-store', async () => {
    const res = await app().request('/ping');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('corsPreflight', () => {
  it('白名单内 Origin 的普通请求 → 放行并带 ACAO + Vary', async () => {
    const res = await app().request('/ping', { headers: { origin: 'https://console.example.com' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://console.example.com');
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('白名单外 Origin → 不带 CORS 头、请求本身照常处理（空表 = 不放行任何跨域）', async () => {
    const res = await app().request('/ping', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('白名单内预检 OPTIONS → 204 + 方法/请求头回显', async () => {
    const res = await app().request('/ping', {
      method: 'OPTIONS',
      headers: { origin: 'https://console.example.com', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect(res.headers.get('Access-Control-Max-Age')).toBeNull(); // 缺省不输出
  });

  it('策略参数化：自定义方法集 / 请求头 / 预检缓存', async () => {
    const a = new Hono();
    a.use(
      '*',
      corsPreflight({
        origins: ['https://gw.example.com'],
        methods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
        maxAgeSeconds: 86_400,
      }),
    );
    a.get('/x', (c) => c.text('ok'));
    const res = await a.request('/x', { method: 'OPTIONS', headers: { origin: 'https://gw.example.com' } });
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type, X-Request-Id');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('白名单外预检 → 不 204，落回正常处理链', async () => {
    const res = await app().request('/ping', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.status).not.toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('bodyParserLimit（maxBytes 必填）', () => {
  it('小于上限的请求体照常到达路由', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(32),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('len:32');
  });

  it('声明的 content-length 超限 → 413 快路径（免读流）+ payload_too_large 信封（context 携带上限）', async () => {
    const res = await app().request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(128), // fetch 自动带 content-length: 128 > 64
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: {
        code: 'http.payload_too_large',
        message: 'Request body too large',
        context: { max_bytes: 64 },
      },
    });
  });

  it('无 content-length 的流式体按实际字节计数（chunked 谎报兜底）→ 413', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(128)));
        controller.close();
      },
    });
    const req = new Request('http://local/echo', {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'text/plain' },
      // undici 要求流式 body 显式 duplex
      ...({ duplex: 'half' } as RequestInit),
    });
    const res = await app().request(req);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('http.payload_too_large');
  });
});
