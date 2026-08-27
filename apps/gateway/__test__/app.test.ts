/**
 * app 面契约：
 * 探针三件 / 未注册路径 404 而非 401 / CORS 白名单与安全头 / bodyLimit 413 /
 * requestId 服务端生成回显 / 中间件顺序副作用。依赖全替身。
 */
import { describe, expect, it } from 'vitest';
import type { Inference } from '@tillgate/inference';
import { createGatewayApp } from '../src/app';
import type { RequestLogStore } from '@tillgate/observability';
import { defined } from './defined';

const inference = {
  chat: async () => ({ ok: true, status: 200, body: {} }),
  stream: async () => ({
    ok: true,
    status: 200,
    stream: new ReadableStream(),
    contentType: 'text/event-stream' as const,
  }),
  generation: {
    submit: async () => ({ ok: true, taskId: 't', expiresAt: 0 }),
    query: async () => null,
  },
  health: {} as never,
  close: () => {},
} as unknown as Inference;

const logs: Array<Record<string, unknown>> = [];
const requestLogs = {
  insert: async (input: Record<string, unknown>) => {
    logs.push(input);
  },
} as unknown as RequestLogStore;

function makeApp(
  over: Parameters<typeof createGatewayApp>[0] extends never
    ? never
    : Partial<Parameters<typeof createGatewayApp>[0]> = {},
) {
  return createGatewayApp({
    inference,
    reader: {
      resolveKeyByHash: async () => ({
        keyId: 1,
        userId: 1,
        rpmLimit: null,
        tpmLimit: null,
        allowPaygFallback: false,
        userRpmLimit: null,
        userTpmLimit: null,
      }),
      resolveApp: async () => null,
    },
    verifyAppClient: async () => null,
    models: { listEnabledMappings: async () => [] },
    requestLogs,
    pingDb: async () => {},
    oauth: {
      jwtSecret: 'ab12'.repeat(8),
      issuer: 'i',
      audience: 'a',
      keyPrefix: 'sk_',
      tokenTtlSeconds: 3_600,
    },
    trustedProxyHops: 0,
    ...over,
  });
}

const STATIC_KEY_AUTH = { headers: { authorization: 'Bearer sk_k' } };

describe('探针', () => {
  it('healthz/readyz 查依赖；readyz 连 Redis 探针；失败 503', async () => {
    const app = makeApp({ redisProbe: { ping: async () => {} } });
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/readyz')).status).toBe(200);
    expect((await app.request('/livez')).status).toBe(200);
    const failing = makeApp({
      pingDb: async () => {
        throw new Error('db down');
      },
    });
    expect((await failing.request('/healthz')).status).toBeGreaterThanOrEqual(500);
  });
});

describe('未注册路径与信封', () => {
  it('未注册 /v1 路径 404（先于 401——鉴权只挂已注册端点）', async () => {
    const app = makeApp();
    const res = await app.request('/v1/not-a-endpoint', { headers: STATIC_KEY_AUTH.headers });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('http.not_found');
  });

  it('requestId 服务端生成并回显（不信任客户端头）', async () => {
    const app = makeApp();
    const a = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        ...STATIC_KEY_AUTH.headers,
        'content-type': 'application/json',
        'x-request-id': 'client-forged',
      },
      body: JSON.stringify({ model: 'm', messages: [{}] }),
    });
    const echoed = defined(a.headers.get('x-request-id'), 'x-request-id');
    expect(echoed).not.toBe('client-forged');
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('安全面', () => {
  it('安全头齐全', async () => {
    const res = await makeApp().request('/livez');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('CORS：白名单 origin 预检 204 + ACAO；非白名单无 ACAO', async () => {
    const app = makeApp({ corsOrigins: ['https://console.example'] });
    const ok = await app.request('/v1/models', {
      method: 'OPTIONS',
      headers: { origin: 'https://console.example', 'access-control-request-method': 'GET' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://console.example');
    const denied = await app.request('/v1/models', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('bodyLimit：超大 content-length 快路径 413', async () => {
    const app = makeApp({ bodyLimitBytes: 1024 });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        ...STATIC_KEY_AUTH.headers,
        'content-type': 'application/json',
        'content-length': '999999',
      },
      body: '{}',
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('http.payload_too_large');
  });
});

describe('请求日志（记录一切 /v1 请求）', () => {
  it('401 也入日志；字段齐全（v1 surface 语义）', async () => {
    logs.length = 0;
    const app = makeApp();
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' }, // 无鉴权头 → 401
      body: JSON.stringify({ model: 'm', messages: [{}] }),
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(logs).toHaveLength(1);
    const entry = defined(logs[0], 'logs[0]');
    expect(entry.statusCode).toBe(401);
    expect(entry.userId).toBeNull();
    expect(entry.method).toBe('POST');
    expect(entry.path).toBe('/v1/chat/completions');
    // 摘要语义:仅路由成功解析 body 后采集——鉴权失败
    // (401)不嗅探 body(clone 嗅探在 node-server 下破坏原始流)
    expect(entry.requestSummary).toBeNull();
    expect(typeof entry.durationMs).toBe('number');
  });

  it('/v1beta Gemini 原生请求也入日志（与 /v1 同语义——补观测缺口）', async () => {
    logs.length = 0;
    const app = makeApp();
    await app.request('/v1beta/models/gemini-x:generateContent', {
      method: 'POST',
      headers: { ...STATIC_KEY_AUTH.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      statusCode: 200,
      method: 'POST',
      path: '/v1beta/models/gemini-x:generateContent',
    });
  });

  it('预认证 per-IP 限流：超限 429 且不写 request_logs（未认证洪水写放大收口）', async () => {
    logs.length = 0;
    let checks = 0;
    const limiter = {
      check: async () => {
        checks += 1;
        return { allowed: checks <= 2 };
      },
    };
    const app = makeApp({
      rateLimit: { limiter: limiter as never, globalRpm: null, preauthIpRpm: 2 },
    });
    const flood = () =>
      app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    expect((await flood()).status).toBe(401); // 未超预认证闸 → 到鉴权层 401（写日志）
    expect((await flood()).status).toBe(401);
    const blocked = await flood();
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
      'gateway.rate_limit_exceeded',
    );
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(logs).toHaveLength(2); // 被预认证闸拒绝的请求不写日志
  });

  it('预认证闸覆盖 /oauth/token：超限 429 且不进凭证验证（第三公网入口同闸）', async () => {
    logs.length = 0;
    let verifyCalls = 0;
    let checks = 0;
    const limiter = {
      check: async () => {
        checks += 1;
        return { allowed: checks <= 1 };
      },
    };
    const app = makeApp({
      verifyAppClient: async () => {
        verifyCalls += 1;
        return null;
      },
      rateLimit: { limiter: limiter as never, globalRpm: null, preauthIpRpm: 1 },
    });
    const post = () =>
      app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: 'app_0123456789abcdef',
          client_secret: 's',
        }),
      });
    await post(); // 闸内 → 进凭证验证
    expect(verifyCalls).toBe(1);
    const blocked = await post(); // 超限 → 429 快速拒
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
      'gateway.rate_limit_exceeded',
    );
    expect(verifyCalls).toBe(1); // 未再触 DB 读
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(logs).toHaveLength(0); // 被拒流量不写日志
  });

  it('写失败不阻塞请求（best-effort）', async () => {
    const app = makeApp({
      requestLogs: {
        insert: async () => {
          throw new Error('log store down');
        },
      } as never,
    });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { ...STATIC_KEY_AUTH.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{}] }),
    });
    expect(res.status).toBe(200);
  });

  it('可选依赖分支：guards/上传限制缺省形态（单副本开发面）', async () => {
    const minimal = makeApp(); // 无 authGuards/rateLimit/corsOrigins/uploadLimits/redisProbe
    const res = await minimal.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{}] }),
    });
    expect(res.status).toBe(200); // 无 guards 仍可鉴权（替身 reader 放行）
    // multipart 全缺省白名单路径：图片白名单拒绝非常见扩展名
    const form = new FormData();
    form.append('model', 'img');
    form.append('prompt', 'p');
    form.append(
      'image',
      new File([new Uint8Array([1])], 'evil.exe', { type: 'application/x-msdownload' }),
    );
    const bad = await minimal.request('/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k' },
      body: form,
    });
    expect(bad.status).toBe(400);
    // 上传限制显式注入分支
    const withUploads = makeApp({
      uploadLimits: {
        imageMime: new Set(['image/png']),
        audioMime: new Set(['audio/mpeg']),
        maxFileBytes: 1024,
      },
    });
    const big = new FormData();
    big.append('model', 'img');
    big.append('prompt', 'p');
    big.append('image', new File([new Uint8Array(2048)], 'x.png', { type: 'image/png' }));
    const oversized = await withUploads.request('/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k' },
      body: big,
    });
    expect(oversized.status).toBe(400);
    expect(((await oversized.json()) as { error: { message: string } }).error.message).toContain(
      'size limit',
    );
  });
});
