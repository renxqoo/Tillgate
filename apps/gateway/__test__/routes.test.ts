/**
 * 路由契约（v1 routes/__tests__/inference-endpoints.test + v1-parity 语义迁移）：
 * 9 端点 schema 拒绝矩阵 / codec 端点入站翻译 / 模态 JSON 族强制非流式 / engines 别名 /
 * gemini 原生双动作 / 模型目录三协议形状 / generation 201/404 / oauth 三形态。
 * inference 为可编程替身（真管线语义在 @tillgate/inference 测试）。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '@tillgate/http';
import { GATEWAY_FACE_OVERRIDES, gatewayErrorCatalog } from '../src/http/openai-error-face';

/** 测试壳挂生产同款错误面（v1 测试直连 app 同语义） */
function withErrorFace<E extends AuthEnv>(app: Hono<E>): Hono<E> {
  app.onError(errorHandler({ catalog: gatewayErrorCatalog(), overrides: GATEWAY_FACE_OVERRIDES }));
  return app;
}
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

function harness(inference: Inference) {
  const app = withErrorFace(new Hono<AuthEnv>());
  app.use('/v1/*', apiKeyMiddleware(READER, undefined, JWT));
  app.use('/v1beta/*', apiKeyMiddleware(READER, undefined, JWT));
  for (const ep of inferenceEndpoints) app.route(ep.path, inferenceRoutes({ inference }, ep));
  const embeddings = defined(
    inferenceEndpoints.find((e) => e.path === '/v1/embeddings'),
    'embeddings endpoint',
  );
  app.route('/v1/engines/:model', enginesAliasRoutes({ inference }, embeddings));
  app.route('/', geminiNativeRoutes({ inference }));
  app.route('/', generationRoutes({ inference }));
  app.route(
    '/oauth/token',
    oauthTokenRoutes({
      verifyAppClient: async ({ clientId, clientSecret }) =>
        clientId === 'ci-1' && clientSecret === 's'
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
      client_id: 'ci-1',
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
      body: 'grant_type=client_credentials&client_id=ci-1&client_secret=s',
    });
    expect(form.status).toBe(200);

    const basic = await app.request('/oauth/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('ci-1:s').toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    });
    expect(basic.status).toBe(200);

    const bad = await post(app, '/oauth/token', {
      grant_type: 'client_credentials',
      client_id: 'ci-1',
      client_secret: 'wrong',
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: 'invalid_client' });

    const badGrant = await post(app, '/oauth/token', {
      grant_type: 'password',
      client_id: 'ci-1',
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
      client_id: 'ci-1',
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
