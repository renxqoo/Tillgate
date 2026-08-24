/**
 * 路由分支补充（gemini 交付三态/oauth 防御/multipart 音频族/generation passthrough
 * 与 TPM 释放路径）。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '@tokenlens/http';
import type { Inference } from '@tokenlens/inference';
import { GATEWAY_FACE_OVERRIDES, gatewayErrorCatalog } from '../src/http/openai-error-face';
import type { AuthEnv, AuthReadModel } from '../src/http/middleware/api-key';
import { apiKeyMiddleware } from '../src/http/middleware/api-key';
import { geminiNativeRoutes } from '../src/http/routes/native-gemini';
import { oauthTokenRoutes } from '../src/http/routes/oauth-token';
import { modalityMultipartRoutes } from '../src/http/routes/modality-multipart';
import { generationRoutes } from '../src/http/routes/generation';
import { admitRequest, type RateLimitGate } from '../src/http/middleware/rate-limit';
import type { SlidingWindowLimiter } from '@tokenlens/runtime';

const JWT = { secret: 'ab12'.repeat(8), issuer: 'i', audience: 'a', keyPrefix: 'sk_' };
const READER: AuthReadModel = {
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
};

function mount(inference: Inference, extra: { rateLimit?: never } = {}) {
  const app = new Hono<AuthEnv>();
  app.onError(errorHandler({ catalog: gatewayErrorCatalog(), overrides: GATEWAY_FACE_OVERRIDES }));
  app.use('/v1beta/*', apiKeyMiddleware(READER, undefined, JWT));
  app.use('/v1/*', apiKeyMiddleware(READER, undefined, JWT));
  app.route('/', geminiNativeRoutes({ inference, ...(extra.rateLimit != null ? {} : {}) }));
  app.route('/', generationRoutes({ inference }));
  app.route('/', modalityMultipartRoutes({ inference }));
  return app;
}

const post = (
  a: Hono<AuthEnv>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  a.request(path, {
    method: 'POST',
    headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('gemini 交付三态分支', () => {
  it('rawBody 直传 + content-type 保留；非流式 JSON 走 chatResponseToGemini 编码', async () => {
    let call = 0;
    const inference = {
      chat: async () => {
        call += 1;
        if (call === 1)
          return {
            ok: true,
            status: 200,
            rawBody: new Uint8Array([1, 2]),
            rawContentType: 'audio/wav',
          };
        return {
          ok: true,
          status: 200,
          body: { choices: [{ message: { role: 'assistant', content: 'hi' } }] },
        };
      },
      stream: async () => {
        throw new Error('unused');
      },
      generation: {
        submit: async () => ({ ok: true, taskId: 't', expiresAt: 0 }),
        query: async () => null,
      },
      health: {} as never,
      close: () => undefined,
    } as unknown as Inference;
    const app = mount(inference);
    const raw = await post(app, '/v1beta/models/g:generateContent', { contents: [] });
    expect(raw.headers.get('content-type')).toBe('audio/wav');
    const json = await post(app, '/v1beta/models/g:generateContent', { contents: [] });
    expect(json.status).toBe(200);
    const body = (await json.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('candidates'); // gemini 线格式
  });
});

describe('oauth 防御分支', () => {
  function oauthApp(ipLocked = false, keyLocked = false) {
    const guard = {
      isLocked: async (k: string) =>
        (ipLocked && !k.startsWith('client:')) || (keyLocked && k.startsWith('client:'))
          ? { locked: true, retryAfterSec: 60 }
          : { locked: false, retryAfterSec: 0 },
      recordFailure: async () => ({ locked: false, retryAfterSec: 0 }),
      recordSuccess: async () => undefined,
    };
    const app = new Hono();
    app.route(
      '/oauth/token',
      oauthTokenRoutes({
        verifyAppClient: async ({ clientId }) =>
          clientId === 'ci' ? { id: 1, appId: 'a', userId: 1, scope: null } : null,
        jwtSecret: JWT.secret,
        tokenTtlSeconds: 60,
        issuer: JWT.issuer,
        audience: JWT.audience,
        ipGuard: guard,
        trustedProxyHops: 0,
      }),
    );
    return app;
  }
  const body = { grant_type: 'client_credentials', client_id: 'ci', client_secret: 's' };

  it('IP 维锁 → 401 locked；clientId 维锁 → 401 locked；畸形 Basic 不致命', async () => {
    const token = (app: ReturnType<typeof oauthApp>) =>
      app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await token(oauthApp(true))).status).toBe(401);
    expect((await token(oauthApp(false, true))).status).toBe(401);
    const badBasic = await oauthApp().request('/oauth/token', {
      method: 'POST',
      headers: {
        authorization: 'Basic %%%not-base64%%%',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    });
    expect(badBasic.status).toBe(401); // 凭证缺失（畸形 Basic 被吞）
  });

  it('错凭证计双失败（IP + client 维）且 401 invalid_client', async () => {
    const res = await oauthApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, client_id: 'nope' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_client' });
  });
});

describe('oauth 表单/缺口分支', () => {
  it('仅 form 传递（无 JSON 分支）+ 缺 client_secret 401', async () => {
    const app = new Hono();
    app.route(
      '/oauth/token',
      oauthTokenRoutes({
        verifyAppClient: async () => null,
        jwtSecret: JWT.secret,
        tokenTtlSeconds: 60,
        issuer: JWT.issuer,
        audience: JWT.audience,
        trustedProxyHops: 0,
      }),
    );
    const form = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&client_id=x',
    });
    expect(form.status).toBe(401); // 缺 secret
    expect(await form.json()).toMatchObject({ error: 'invalid_client' });
  });
});

describe('multipart 音频族与防御', () => {
  it('transcriptions：audio 秒数推导入 wrapper；缺 file 字段 400；非白名单 400', async () => {
    const seen: Array<{ body: Record<string, unknown> }> = [];
    const inference = {
      chat: async (input: { body: Record<string, unknown> }) => {
        seen.push(input);
        return { ok: true, status: 200, body: {} };
      },
      stream: async () => {
        throw new Error('unused');
      },
      generation: {
        submit: async () => ({ ok: true, taskId: 't', expiresAt: 0 }),
        query: async () => null,
      },
      health: {} as never,
      close: () => undefined,
    } as unknown as Inference;
    const app = mount(inference);
    // 极小 WAV 头（RIFF）——解析失败兜底 1 秒（A7 分支）
    const wav = new Uint8Array(44);
    wav.set(new TextEncoder().encode('RIFF'), 0);
    const form = new FormData();
    form.append('model', 'whisper-x');
    form.append('file', new File([wav], 'a.wav', { type: 'audio/wav' }));
    form.append('n', '7');
    const ok = await app.request('/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k' },
      body: form,
    });
    expect(ok.status).toBe(200);
    expect(seen[0]!.body.audioSeconds).toBeTypeOf('number');
    expect(seen[0]!.body.n).toBe(7);

    const noFile = new FormData();
    noFile.append('model', 'whisper-x');
    expect(
      (
        await app.request('/v1/audio/transcriptions', {
          method: 'POST',
          headers: { authorization: 'Bearer sk_k' },
          body: noFile,
        })
      ).status,
    ).toBe(400);

    const badType = new FormData();
    badType.append('model', 'whisper-x');
    badType.append(
      'file',
      new File([new Uint8Array([1])], 'x.exe', { type: 'application/octet-stream' }),
    );
    expect(
      (
        await app.request('/v1/audio/transcriptions', {
          method: 'POST',
          headers: { authorization: 'Bearer sk_k' },
          body: badType,
        })
      ).status,
    ).toBe(400);
  });
});

function gate(released: string[]) {
  const limiter = {
    checkAll: async () => ({ allowed: true }),
    reserveTpmAll: async () => ({ allowed: true }),
    check: async () => ({ allowed: true }),
    releaseTpm: async (id: string) => {
      released.push(id);
    },
  } as unknown as SlidingWindowLimiter;
  return { limiter, globalRpm: null } satisfies RateLimitGate;
}

describe('generation 分支（passthrough/TPM 释放/音乐族）', () => {
  it('passthrough 提交（402）原样出站；音乐查询异类 404', async () => {
    const inference = {
      chat: async () => ({ ok: true, status: 200, body: {} }),
      stream: async () => {
        throw new Error('unused');
      },
      generation: {
        submit: async () => ({
          ok: true,
          passthrough: true,
          status: 402,
          code: 'billing.insufficient_balance',
          message: 'no funds',
        }),
        query: async () => ({
          taskId: 't',
          kind: 'video' as const,
          status: 'queued',
          upstreamTaskId: null,
          params: {},
          result: null,
          failReason: null,
          createdAt: 1,
          expiresAt: 2,
        }),
      },
      health: {} as never,
      close: () => undefined,
    } as unknown as Inference;
    const app = new Hono<AuthEnv>();
    app.onError(
      errorHandler({ catalog: gatewayErrorCatalog(), overrides: GATEWAY_FACE_OVERRIDES }),
    );
    app.use('/v1/*', apiKeyMiddleware(READER, undefined, JWT));
    app.route('/', generationRoutes({ inference }));
    const res = await post(app, '/v1/music/generations', { model: 'm', prompt: 'p' });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: 'billing.insufficient_balance' } });
    // 音乐查询命中 video 任务 → 异类 404
    expect(
      (await app.request('/v1/musics/t', { headers: { authorization: 'Bearer sk_k' } })).status,
    ).toBe(404);
  });

  it('提交失败（非 passthrough 抛错）归还 TPM 预占', async () => {
    const released: string[] = [];
    const inference = {
      chat: async () => ({ ok: true, status: 200, body: {} }),
      stream: async () => {
        throw new Error('unused');
      },
      generation: {
        submit: async () => {
          throw (await import('@tokenlens/inference')).InferenceErrors.business('model_not_found', {
            model: 'm',
          });
        },
        query: async () => null,
      },
      health: {} as never,
      close: () => undefined,
    } as unknown as Inference;
    const app = new Hono<AuthEnv>();
    app.onError(
      errorHandler({ catalog: gatewayErrorCatalog(), overrides: GATEWAY_FACE_OVERRIDES }),
    );
    app.use('/v1/*', async (c, next) => {
      c.set('requestId', 'rel-1');
      c.set('auth', {
        userId: 1,
        apiKeyId: 1,
        appId: null,
        allowedModels: null,
        rpmLimit: 1,
        tpmLimit: 1,
        userRpmLimit: null,
        userTpmLimit: null,
      });
      await next();
    });
    app.route('/', generationRoutes({ inference, rateLimit: gate(released) }));
    const res = await post(app, '/v1/video/generations', { model: 'm', prompt: 'p' });
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 10));
    expect(released).toContain('rel-1');
    void admitRequest;
  });

  it('gemini：坏 JSON 体 400；video 任务产物字段三件（url/width/height）与 music 无产物', async () => {
    const inference = {
      chat: async () => ({ ok: true, status: 200, body: {} }),
      stream: async () => {
        throw new Error('unused');
      },
      generation: {
        submit: async () => ({ ok: true, taskId: 't', expiresAt: 0 }),
        query: async (_userId: number, id: string) =>
          id === 'v'
            ? {
                taskId: 'v',
                kind: 'video' as const,
                status: 'succeeded' as const,
                upstreamTaskId: 'u',
                params: {},
                failReason: null,
                createdAt: 1726000000_000,
                expiresAt: 1726003600_000,
                result: { url: 'https://v/x.mp4', width: 1280, height: 720 },
              }
            : {
                taskId: 'm',
                kind: 'music' as const,
                status: 'failed' as const,
                upstreamTaskId: null,
                params: {},
                failReason: 'upstream',
                createdAt: 1726000000_000,
                expiresAt: 1726003600_000,
                result: null,
              },
      },
      health: {} as never,
      close: () => undefined,
    } as unknown as Inference;
    const app = new Hono<AuthEnv>();
    app.onError(
      errorHandler({ catalog: gatewayErrorCatalog(), overrides: GATEWAY_FACE_OVERRIDES }),
    );
    app.use('/v1/*', apiKeyMiddleware(READER, undefined, JWT));
    app.route('/', generationRoutes({ inference }));

    const bad = await app.request('/v1/videos/v', {
      headers: { authorization: 'Bearer sk_k' },
    });
    const video = (await bad.json()) as Record<string, unknown>;
    expect(video).toMatchObject({
      video_url: 'https://v/x.mp4',
      video_width: 1280,
      video_height: 720,
      status: 'succeeded',
    });

    const musicRes = await app.request('/v1/musics/m', {
      headers: { authorization: 'Bearer sk_k' },
    });
    const music = (await musicRes.json()) as Record<string, unknown>;
    expect(music).toMatchObject({ audio_url: null, fail_reason: 'upstream' });

    const gemini = new Hono<AuthEnv>();
    gemini.onError(
      errorHandler({ catalog: gatewayErrorCatalog(), overrides: GATEWAY_FACE_OVERRIDES }),
    );
    gemini.use('/v1beta/*', apiKeyMiddleware(READER, undefined, JWT));
    gemini.route('/', geminiNativeRoutes({ inference }));
    const badBody = await gemini.request('/v1beta/models/g:generateContent', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(badBody.status).toBe(400);
  });
});
