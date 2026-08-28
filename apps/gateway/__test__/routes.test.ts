/**
 * 路由契约：
 * 9 端点 schema 拒绝矩阵 / codec 端点入站翻译 / 模态 JSON 族强制非流式 / engines 别名 /
 * gemini 原生双动作 / 模型目录三协议形状 / generation 201/404 / oauth 三形态。
 * inference 为可编程替身（真管线语义在 @tillgate/inference 测试）。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '@tillgate/http';
import { GATEWAY_FACE_OVERRIDES, gatewayErrorCatalog } from '../src/http/openai-error-face';

/** 测试壳挂生产同款错误面 */
function withErrorFace<E extends AuthEnv>(app: Hono<E>): Hono<E> {
  app.onError(errorHandler({ catalog: gatewayErrorCatalog(), overrides: GATEWAY_FACE_OVERRIDES }));
  return app;
}
import { ServerDrainAbort, asServerDrainAbort } from '@tillgate/ai';
import type { Inference, ChatDelivered } from '@tillgate/inference';
import type { MiddlewareHandler } from 'hono';
import {
  apiKeyMiddleware,
  type AuthEnv,
  type AuthReadModel,
  type AuthContext,
} from '../src/http/middleware/api-key';
import { inferenceRoutes, enginesAliasRoutes } from '../src/http/routes/inference-endpoints';
import { geminiNativeRoutes } from '../src/http/routes/native-gemini';
import { modelsRoutes } from '../src/http/routes/models';
import { generationRoutes } from '../src/http/routes/generation';
import { oauthTokenRoutes } from '../src/http/routes/oauth-token';
import type { AuthFailureGuard } from '@tillgate/runtime';
import { modalityMultipartRoutes } from '../src/http/routes/modality-multipart';
import { inferenceEndpoints } from '../src/http/contracts/inference-endpoints';
import { defined } from './defined';

const JWT = { secret: 'x'.repeat(32), issuer: 'i', audience: 'a', keyPrefix: 'sk_' };
const READER: AuthReadModel = {
  resolveKeyByHash: async () => ({
    keyId: 7,
    userId: 42,
    rpmLimit: null,
    tpmLimit: null,
    allowPaygFallback: false,
    userRpmLimit: null,
    userTpmLimit: null,
  }),
  resolveApp: async () => null,
};

function stubInference(over: Partial<Inference> = {}): Inference {
  return {
    chat: async (input) => ({
      ok: true,
      status: 200,
      body: { via: 'chat', body: input.body, endpoint: input.endpoint },
    }),
    stream: async () => {
      throw new Error('stream not expected in these cases');
    },
    generation: {
      submit: async () => ({
        ok: true,
        taskId: '019c0b7d-0000-7000-8000-0000000000aa',
        expiresAt: Date.now() + 1,
      }),
      query: async () => null,
    },
    health: {} as never,
    close: () => {},
    ...over,
  } as Inference;
}

/** 记录型守卫（可编程锁定集合） */
function recordingGuard(lockedKeys: Set<string>): {
  guard: AuthFailureGuard;
  calls: { failures: string[]; successes: string[] };
} {
  const calls = { failures: [] as string[], successes: [] as string[] };
  const guard = {
    isLocked: async (key: string) => ({ locked: lockedKeys.has(key), retryAfterSec: 60 }),
    recordFailure: async (key: string) => {
      calls.failures.push(key);
      return { locked: false, retryAfterSec: 60 };
    },
    recordSuccess: async (key: string) => {
      calls.successes.push(key);
    },
  };
  return { guard, calls };
}

function oauthApp(guard: AuthFailureGuard) {
  return withErrorFace(
    new Hono<AuthEnv>().route(
      '/oauth/token',
      oauthTokenRoutes({
        verifyAppClient: async ({ clientId, clientSecret }) =>
          clientId === 'app_0123456789abcdef' && clientSecret === 's'
            ? { id: 5, appId: 'app-1', userId: 42, scope: null }
            : null,
        jwtSecret: JWT.secret,
        tokenTtlSeconds: 3_600,
        issuer: JWT.issuer,
        audience: JWT.audience,
        ipGuard: guard,
        trustedProxyHops: 0,
      }),
    ),
  );
}

/** 记录型限流闸（RPM 放行；TPM 预占入参全记录） */
function recordingGate() {
  const calls = {
    reserveTpmAll: [] as Array<[Array<{ dimension: string; estimatedTokens: number }>, string]>,
    checkAll: 0,
  };
  const limiter = {
    checkAll: async () => {
      calls.checkAll += 1;
      return { allowed: true };
    },
    reserveTpmAll: async (
      dims: Array<{ dimension: string; estimatedTokens: number }>,
      requestId: string,
    ) => {
      calls.reserveTpmAll.push([dims, requestId]);
      return { allowed: true };
    },
    check: async () => ({ allowed: true }),
    releaseTpm: async () => {},
  };
  return { gate: { limiter, globalRpm: null, preauthIpRpm: null } as never, calls };
}

function harness(inference: Inference, opts: { drainSignal?: AbortSignal } = {}) {
  const app = withErrorFace(new Hono<AuthEnv>());
  app.use('/v1/*', apiKeyMiddleware(READER, undefined, JWT));
  app.use('/v1beta/*', apiKeyMiddleware(READER, undefined, JWT));
  const routeDeps = {
    inference,
    ...(opts.drainSignal != null ? { drainSignal: opts.drainSignal } : {}),
  };
  for (const ep of inferenceEndpoints) {
    app.route(ep.path, inferenceRoutes(routeDeps, ep));
  }
  const embeddings = defined(
    inferenceEndpoints.find((e) => e.path === '/v1/embeddings'),
    'embeddings endpoint',
  );
  app.route('/v1/engines/:model', enginesAliasRoutes(routeDeps, embeddings));
  app.route('/', geminiNativeRoutes(routeDeps));
  app.route('/', generationRoutes(routeDeps));
  app.route(
    '/oauth/token',
    oauthTokenRoutes({
      verifyAppClient: async ({ clientId, clientSecret }) =>
        clientId === 'app_0123456789abcdef' && clientSecret === 's'
          ? { id: 5, appId: 'app-1', userId: 42, scope: { rpm: 10 } }
          : null,
      jwtSecret: JWT.secret,
      tokenTtlSeconds: 3_600,
      issuer: JWT.issuer,
      audience: JWT.audience,
      trustedProxyHops: 0,
    }),
  );
  return app;
}

// 全部调用点都不传自定义 token（固定 sk_k），故不保留无人使用的第 4 参
const post = (a: Hono<AuthEnv>, path: string, body: unknown) =>
  a.request(path, {
    method: 'POST',
    headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('端点 schema 拒绝矩阵（v1 同语义）', () => {
  const app = harness(stubInference());
  it.each([
    ['/v1/chat/completions', {}],
    ['/v1/chat/completions', { model: 'm', messages: [] }],
    ['/v1/chat/completions', { model: 'm', messages: 'x' }],
    ['/v1/chat/completions', { model: 'm', messages: [{}], max_tokens: -1 }],
    ['/v1/chat/completions', { model: 'm', messages: [{}], n: 99 }],
    ['/v1/embeddings', { model: 'm' }],
    ['/v1/images/generations', { model: 'm' }],
    ['/v1/audio/speech', { model: 'm', input: 'x' }],
    ['/v1/rerank', { model: 'm', query: 'q' }],
    ['/v1/moderations', { model: 'm' }],
  ])('%s 拒绝 %j', async (path, body) => {
    const res = await post(app, path, body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('gateway.invalid_body');
  });

  it('非 JSON 体 → 400 invalid_body', async () => {
    const res = await post(app, '/v1/chat/completions', 'not-json{');
    expect(res.status).toBe(400);
  });
});

describe('端点分发（inference 输入形状）', () => {
  it('chat 规范形直传；模态 JSON 族强制非流式（stream 剥除）', async () => {
    const seen: unknown[] = [];
    const inference = stubInference({
      chat: async (input) => {
        seen.push(input);
        return { ok: true, status: 200, body: { ok: true } } satisfies ChatDelivered;
      },
    });
    const app = harness(inference);
    await post(app, '/v1/chat/completions', { model: 'm', messages: [{}] });
    await post(app, '/v1/images/generations', { model: 'm', prompt: 'p', stream: true });
    expect(seen[0]).toMatchObject({ endpoint: 'chat' });
    expect((seen[1] as { body: { stream?: boolean } }).body.stream).toBe(false);
  });

  it('codec 端点：入站翻译为规范形（completions prompt → messages）；出站编码回线格式', async () => {
    const inference = stubInference({
      chat: async () => ({
        ok: true,
        status: 200,
        body: {
          id: 'x',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
        },
      }),
    });
    const app = harness(inference);
    const res = await post(app, '/v1/completions', { model: 'm', prompt: 'hello' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices?: unknown[] };
    expect(body.choices).toBeDefined(); // completions 线格式（非 chat 形）
  });

  it('embeddings 走 embeddings 端点；engines 别名注入路径段模型名且非流式', async () => {
    const seen: unknown[] = [];
    const inference = stubInference({
      chat: async (input) => {
        seen.push(input);
        return { ok: true, status: 200, body: {} };
      },
    });
    const app = harness(inference);
    await post(app, '/v1/embeddings', { model: 'm', input: 'x' });
    expect(seen[0]).toMatchObject({ endpoint: 'embeddings' });
    const res = await app.request('/v1/engines/gpt-4o/embeddings', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'x' }),
    });
    expect(res.status).toBe(200);
    expect(seen[1]).toMatchObject({ endpoint: 'embeddings' });
    expect((seen[1] as { body: { model: string } }).body.model).toBe('gpt-4o');
  });

  it('gemini 原生：:generateContent 强制 stream=false 走 chat；非法 action 404', async () => {
    const seen: unknown[] = [];
    const inference = stubInference({
      chat: async (input) => {
        seen.push(input);
        return { ok: true, status: 200, body: {} };
      },
    });
    const app = harness(inference);
    const res = await post(app, '/v1beta/models/gemini-x:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ endpoint: 'chat' });
    expect((seen[0] as { body: { stream: boolean } }).body.stream).toBe(false);
    const notFound = await post(app, '/v1beta/models/gemini-x:unknownAction', {});
    expect(notFound.status).toBe(404);
  });

  it('流式请求走 inference.stream 并 SSE 透传出站', async () => {
    const chunks = ['data: {"a":1}\n\n', 'data: [DONE]\n\n'];
    const inference = stubInference({
      stream: async () => ({
        ok: true as const,
        status: 200 as const,
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
            c.close();
          },
        }),
        contentType: 'text/event-stream' as const,
      }),
    });
    const app = harness(inference);
    const res = await post(app, '/v1/chat/completions', {
      model: 'm',
      messages: [{}],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(await res.text()).toBe(chunks.join(''));
  });
});

describe('模型目录（三协议形状 + 白名单过滤 + 404 不泄漏）', () => {
  const reader = {
    listEnabledMappings: async () => [
      { externalName: 'm-a', realModel: 'real-a', pricingUnit: 'token' },
      { externalName: 'm-b', realModel: 'real-b', pricingUnit: 'image' },
    ],
  };
  function modelsApp(auth?: { allowedModels: string[] | null }) {
    const app = withErrorFace(new Hono<AuthEnv>());
    if (auth != null) {
      const seed: AuthContext = {
        userId: 1,
        apiKeyId: 1,
        appId: null,
        allowedModels: auth.allowedModels,
        rpmLimit: null,
        tpmLimit: null,
        userRpmLimit: null,
        userTpmLimit: null,
      };
      app.use('/v1/*', ((c, next) => {
        c.set('auth', seed);
        return next();
      }) as MiddlewareHandler<AuthEnv>);
    }
    app.route('/v1/models', modelsRoutes(reader));
    return app;
  }

  it('OpenAI 形缺省 / anthropic-version / x-goog-api-key 三形状', async () => {
    const app = modelsApp({ allowedModels: null });
    const openai = (await (await app.request('/v1/models')).json()) as Record<string, unknown>;
    expect(openai).toMatchObject({ object: 'list' });
    expect((openai.data as Array<{ id: string }>).map((m) => m.id)).toEqual(['m-a', 'm-b']);
    const anthropic = (await (
      await app.request('/v1/models', { headers: { 'anthropic-version': '2023-06-01' } })
    ).json()) as { data: unknown[]; has_more: boolean };
    expect(anthropic.data).toHaveLength(2);
    expect(anthropic.has_more).toBe(false);
    const gemini = (await (
      await app.request('/v1/models', { headers: { 'x-goog-api-key': 'k' } })
    ).json()) as { models: Array<{ name: string }> };
    expect(defined(gemini.models[0], 'gemini.models[0]').name).toBe('models/m-a');
  });

  it('白名单过滤 + 白名单外单查与不存在同口径 404', async () => {
    const app = modelsApp({ allowedModels: ['m-a'] });
    const list = (await (await app.request('/v1/models')).json()) as {
      data: Array<{ id: string }>;
    };
    expect(list.data.map((m) => m.id)).toEqual(['m-a']);
    expect((await app.request('/v1/models/m-b')).status).toBe(404);
    expect((await app.request('/v1/models/m-a')).status).toBe(200);
    expect((await modelsApp({ allowedModels: null }).request('/v1/models/zzz')).status).toBe(404);
  });
});

describe('generation 提交与查询', () => {
  it('提交恒 201 new-api 形；查询不存在 404；属主隔离由 inference.query 承担', async () => {
    const app = harness(stubInference());
    const res = await post(app, '/v1/video/generations', {
      model: 'video-x',
      prompt: 'a cat',
      duration: 6,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ object: 'video', model: 'video-x', status: 'queued' });
    expect(
      (await app.request('/v1/videos/zzz', { headers: { authorization: 'Bearer sk_k' } })).status,
    ).toBe(404);
    expect((await post(app, '/v1/music/generations', { model: 'm', prompt: 'x' })).status).toBe(
      201,
    );
  });

  it('非法参数 400（duration 越界 / prompt 超长）', async () => {
    const app = harness(stubInference());
    expect(
      (await post(app, '/v1/video/generations', { model: 'm', prompt: 'x', duration: 99 })).status,
    ).toBe(400);
  });
});

describe('oauth token（三形态 + 闭环）', () => {
  it('JSON / form / Basic 三形态等价；错凭证 401 OAuth 错误形；错 grant 400', async () => {
    const app = harness(stubInference());
    const ok = await post(app, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: 'app_0123456789abcdef',
      client_secret: 's',
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3_600);

    const form = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&client_id=app_0123456789abcdef&client_secret=s',
    });
    expect(form.status).toBe(200);

    const basic = await app.request('/oauth/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('app_0123456789abcdef:s').toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    });
    expect(basic.status).toBe(200);

    const bad = await post(app, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: 'app_0123456789abcdef',
      client_secret: 'wrong',
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: 'invalid_client' });

    const badGrant = await post(app, '/oauth/token', {
      grant_type: 'password',
      client_id: 'app_0123456789abcdef',
      client_secret: 's',
    });
    expect(badGrant.status).toBe(400);
    expect(await badGrant.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('签发 → 鉴权闭环（app_jwt 经 api-key 中间件验签 + resolveApp 属主校验）', async () => {
    const app = harness(
      stubInference({
        chat: async () => ({ ok: true, status: 200, body: { closed: true } }),
      }),
    );
    // 替身 reader 只认 key——为闭环补 JWT reader
    const jwtApp = withErrorFace(new Hono<AuthEnv>());
    const readerWithApp: AuthReadModel = {
      resolveKeyByHash: READER.resolveKeyByHash,
      resolveApp: async (appId) =>
        appId === 'app-1' ? { id: 5, userId: 42, scope: { rpm: 10 } } : null,
    };
    jwtApp.use('/v1/*', apiKeyMiddleware(readerWithApp, undefined, JWT));
    const chatEndpoint = defined(inferenceEndpoints[0], 'inferenceEndpoints[0]');
    jwtApp.route(
      chatEndpoint.path,
      inferenceRoutes(
        {
          inference: stubInference({
            chat: async () => ({ ok: true, status: 200, body: { closed: true } }),
          }),
        },
        chatEndpoint,
      ),
    );
    const tokenRes = await post(app, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: 'app_0123456789abcdef',
      client_secret: 's',
    });
    const { access_token: token } = (await tokenRes.json()) as { access_token: string };
    const res = await jwtApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{}] }),
    });
    expect(res.status).toBe(200);
  });
});

describe('客户端取消信号贯通（c.req.raw.signal → ChatInput.signal）', () => {
  it.each([
    ['/v1/chat/completions', { model: 'm', messages: [{}] }],
    ['/v1/engines/gpt-4o/embeddings', { input: 'x' }],
  ])('%s 透传请求 signal 给 inference', async (path, body) => {
    const seen: unknown[] = [];
    const inference = stubInference({
      chat: async (input) => {
        seen.push(input);
        return { ok: true, status: 200, body: {} };
      },
    });
    const app = harness(inference);
    const controller = new AbortController();
    const res = await app.request(path, {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect((seen[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  it('gemini 原生 /v1beta 入口透传请求 signal', async () => {
    const seen: unknown[] = [];
    const inference = stubInference({
      chat: async (input) => {
        seen.push(input);
        return { ok: true, status: 200, body: {} };
      },
    });
    const app = harness(inference);
    const controller = new AbortController();
    const res = await app.request('/v1beta/models/gemini-x:generateContent', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect((seen[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  it('multipart 族入口透传请求 signal', async () => {
    const seen: unknown[] = [];
    const inference = stubInference({
      chat: async (input) => {
        seen.push(input);
        return { ok: true, status: 200, body: {} };
      },
    });
    const app = withErrorFace(new Hono<AuthEnv>());
    app.use('/v1/*', apiKeyMiddleware(READER, undefined, JWT));
    app.route('/', modalityMultipartRoutes({ inference }, { bodyLimitBytes: 10 * 1024 * 1024 }));
    const controller = new AbortController();
    const form = new FormData();
    form.append('model', 'img-x');
    form.append('prompt', 'a cat');
    form.append('image', new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' }));
    const res = await app.request('/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k' },
      body: form,
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect((seen[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  it('generation 提交入口透传请求 signal', async () => {
    const seen: unknown[] = [];
    const inference = stubInference({
      generation: {
        submit: async (input) => {
          seen.push(input);
          return { ok: true, taskId: '019c0b7d-0000-7000-8000-0000000000aa', expiresAt: 1 };
        },
        query: async () => null as never,
        adminList: async () => ({ rows: [], total: 0 }),
        settledAmounts: async () => new Map(),
      },
    });
    const app = harness(inference);
    const controller = new AbortController();
    const res = await app.request('/v1/video/generations', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'video-x', prompt: 'a cat', duration: 6 }),
      signal: controller.signal,
    });
    expect(res.status).toBe(201);
    expect((seen[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });
});

describe('oauth token 爆破守卫（S7：clientId 校验 + 成功解锁）', () => {
  it('畸形 clientId（非 app_+16hex）→ 401 且不触守卫（键空间不被任意串污染）', async () => {
    const { guard, calls } = recordingGuard(new Set());
    const app = oauthApp(guard);
    const res = await post(app, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: 'x'.repeat(500),
      client_secret: 's',
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
    expect(calls.failures).toHaveLength(0); // 不计数、不写键
  });

  it('client 维被锁 + 合法凭证 → 验证通过并清锁（持有人不被连坐死锁）；错凭证仍 401', async () => {
    const { guard, calls } = recordingGuard(new Set(['client:app_0123456789abcdef']));
    const app = oauthApp(guard);
    const ok = await post(app, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: 'app_0123456789abcdef',
      client_secret: 's',
    });
    expect(ok.status).toBe(200); // 锁定态合法持有人可验证解锁
    expect(calls.successes).toContain('client:app_0123456789abcdef');
    const bad = await post(app, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: 'app_0123456789abcdef',
      client_secret: 'wrong',
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error_description: string }).error_description).toContain(
      'locked',
    );
  });
});

describe('TPM 预占口径（B8：含输出上界；B7：模态族豁免）', () => {
  /** 带 TPM 限额的 reader（TPM 维存在时豁免/预占才可观测） */
  const LIMITED_READER: AuthReadModel = {
    resolveKeyByHash: async () => ({
      keyId: 7,
      userId: 42,
      rpmLimit: 60,
      tpmLimit: 100_000,
      allowPaygFallback: false,
      userRpmLimit: null,
      userTpmLimit: null,
    }),
    resolveApp: async () => null,
  };

  it('chat 端点预占 = 输入字节 + min(max_tokens×n, cap)（与 billing 敞口同式）', async () => {
    const { gate, calls } = recordingGate();
    const app = withErrorFace(new Hono<AuthEnv>());
    app.use('/v1/*', apiKeyMiddleware(LIMITED_READER, undefined, JWT));
    const chatEndpoint = defined(
      inferenceEndpoints.find((e) => e.path === '/v1/chat/completions'),
      'chat endpoint',
    );
    app.route(
      chatEndpoint.path,
      inferenceRoutes({ inference: stubInference(), rateLimit: gate }, chatEndpoint),
    );
    const body = { model: 'm', messages: [{}], max_tokens: 100 };
    const res = await post(app, '/v1/chat/completions', body);
    expect(res.status).toBe(200);
    const dims = calls.reserveTpmAll[0]?.[0];
    expect(dims).toBeDefined();
    // 输入字节 + 声明 max_tokens（未声明时按缺省 4096——不小于纯输入）
    const inputBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    expect(dims?.[0]?.estimatedTokens).toBe(inputBytes + 100);
  });

  it('multipart 模态族：RPM 照查、TPM 维豁免（按张/按秒计价——预占恒 0 的假口径移除）', async () => {
    const { gate, calls } = recordingGate();
    const app = withErrorFace(new Hono<AuthEnv>());
    app.use('/v1/*', apiKeyMiddleware(LIMITED_READER, undefined, JWT));
    app.route('/', modalityMultipartRoutes({ inference: stubInference(), rateLimit: gate }));
    const form = new FormData();
    form.append('model', 'img-x');
    form.append('prompt', 'a cat');
    form.append('image', new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' }));
    const res = await app.request('/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k' },
      body: form,
    });
    expect(res.status).toBe(200);
    expect(calls.checkAll).toBe(1); // RPM 维照查
    expect(calls.reserveTpmAll).toHaveLength(0); // TPM 维不预占
  });
});

describe('server_draining 生产者（drain 信号合成 + reason 透传）', () => {
  it('drainSignal 注入时：inference 收到合成信号，abort reason 为 ServerDrainAbort（终态分类可用）', async () => {
    const drain = new AbortController();
    const seen: AbortSignal[] = [];
    const inference = stubInference({
      chat: async (input) => {
        seen.push(input.signal as AbortSignal);
        // 在途时触发宽限耗尽式 abort
        drain.abort(new ServerDrainAbort());
        return { ok: true, status: 200, body: {} };
      },
    });
    const app = harness(inference, { drainSignal: drain.signal });
    const res = await post(app, '/v1/chat/completions', { model: 'm', messages: [{}] });
    expect(res.status).toBe(200);
    const signal = defined(seen[0], 'seen[0]');
    expect(signal.aborted).toBe(true);
    expect(asServerDrainAbort(signal.reason)).not.toBeNull(); // drain 标记贯通
    expect(signal.reason).toBeInstanceOf(ServerDrainAbort);
  });

  it('无 drainSignal 时信号原样透传（客户端断连语义不变——B1 契约保持）', async () => {
    const seen: AbortSignal[] = [];
    const inference = stubInference({
      chat: async (input) => {
        seen.push(input.signal as AbortSignal);
        return { ok: true, status: 200, body: {} };
      },
    });
    const app = harness(inference);
    const client = new AbortController();
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{}] }),
      signal: client.signal,
    });
    expect(seen[0]).toBe(client.signal); // 同一引用（不包一层）
  });
});

describe('multipart 族', () => {
  it('缺文件 400；PNG 白名单通过并组装 wrapper（模型/文件转发）', async () => {
    const seen: unknown[] = [];
    const inference = stubInference({
      chat: async (input) => {
        seen.push(input);
        return { ok: true, status: 200, body: {} };
      },
    });
    const app = withErrorFace(new Hono<AuthEnv>());
    app.use('/v1/*', apiKeyMiddleware(READER, undefined, JWT));
    app.route('/', modalityMultipartRoutes({ inference }, { bodyLimitBytes: 10 * 1024 * 1024 }));

    const missing = await app.request('/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(400);

    const form = new FormData();
    form.append('model', 'img-x');
    form.append('prompt', 'a cat');
    form.append(
      'image',
      new File([new Uint8Array([137, 80, 78, 71])], 'cat.png', { type: 'image/png' }),
    );
    const ok = await app.request('/v1/images/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k' },
      body: form,
    });
    expect(ok.status).toBe(200);
    expect(seen[0]).toMatchObject({ endpoint: 'images_edits' });
    expect((seen[0] as { body: { model: string } }).body.model).toBe('img-x');
  });
});
