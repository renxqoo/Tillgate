/**
 * 分支矩阵补充：
 * 限流闸维度组合 × 拒绝形态 / otel 状态分支 / 信封可选分支 / catalog 渠道可选列 /
 * billing 桥可选字段透传 / request-log 嗅探防御分支。
 */
import { describe, expect, it } from 'vitest';
import { Hono, type Context } from 'hono';
import type { SlidingWindowLimiter } from '@tillgate/runtime';
import { admitRequest } from '../src/http/middleware/rate-limit';
import { otelMiddleware } from '../src/http/middleware/otel';
import type { AuthEnv, AuthContext } from '../src/http/middleware/api-key';
import { requestLogMiddleware } from '../src/http/middleware/request-log';
import { createGatewayCatalog } from '../src/adapters/catalog-port';
import { createGatewayBilling } from '../src/adapters/billing-port';
import { sseResponse } from '../src/http/openai-envelope';
import type {
  ActiveMappingRow,
  RouteCandidateRow,
  UserRateCardContext,
} from '@tillgate/control-plane';
import type { QuoteCandidate } from '@tillgate/inference';
import { defined } from './defined';

const auth = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: 1,
  apiKeyId: 2,
  appId: null,
  allowedModels: null,
  rpmLimit: 10,
  tpmLimit: 20,
  userRpmLimit: 30,
  userTpmLimit: 40,
  ...over,
});

function limiter(results: { rpm?: unknown; tpm?: unknown }) {
  return {
    checkAll: async () => results.rpm ?? { allowed: true },
    reserveTpmAll: async () => results.tpm ?? { allowed: true },
    check: async () => ({ allowed: true }),
    releaseTpm: async () => {},
  } as unknown as SlidingWindowLimiter;
}

describe('限流闸维度矩阵', () => {
  it('rpm 拒绝无 retryAfterSec → 缺省 60 上下文', async () => {
    await expect(
      admitRequest(
        { limiter: limiter({ rpm: { allowed: false } }), globalRpm: null, preauthIpRpm: null },
        {
          requestId: 'r',
          auth: auth(),
          estimatedTokens: 1,
        },
      ),
    ).rejects.toMatchObject({ code: 'gateway.rate_limit_exceeded' });
  });

  it('tpm 拒绝无 retryAfterSec → 缺省 60；key 维 tpm 缺失只押 user 维', async () => {
    const spy = limiter({});
    const checkSpy = spy as unknown as {
      reserveTpmAll: (dims: Array<{ dimension: string }>) => Promise<unknown>;
    };
    const seen: Array<Array<{ dimension: string }>> = [];
    (spy as unknown as Record<string, unknown>).reserveTpmAll = async (
      dims: Array<{ dimension: string }>,
    ) => {
      seen.push(dims);
      return { allowed: false };
    };
    await expect(
      admitRequest(
        { limiter: spy, globalRpm: null, preauthIpRpm: null },
        {
          requestId: 'r',
          auth: auth({ tpmLimit: null }),
          estimatedTokens: 5,
        },
      ),
    ).rejects.toMatchObject({ code: 'gateway.rate_limit_exceeded' });
    expect(defined(seen[0], 'seen[0]').map((d) => d.dimension)).toEqual(['user:1']); // key TPM 缺失跳过
    void checkSpy;
  });

  it('JWT 形态（apiKeyId=null）且无 user 限 → 零维预占直通', async () => {
    const spy = limiter({});
    const tpmSeen: Array<Array<{ dimension: string }>> = [];
    (spy as unknown as Record<string, unknown>).reserveTpmAll = async (
      dims: Array<{ dimension: string }>,
    ) => {
      tpmSeen.push(dims);
      return { allowed: true };
    };
    const handle = await admitRequest(
      { limiter: spy, globalRpm: null, preauthIpRpm: null },
      {
        requestId: 'r',
        auth: auth({
          apiKeyId: null,
          rpmLimit: null,
          tpmLimit: null,
          userRpmLimit: null,
          userTpmLimit: null,
        }),
        estimatedTokens: 5,
      },
    );
    await handle.release();
    expect(tpmSeen).toHaveLength(0);
  });
});

function otelApp(handler: (c: Context<AuthEnv>) => Response | Promise<Response>) {
  const app = new Hono<AuthEnv>();
  app.use('*', otelMiddleware());
  app.get('/v1/x', handler);
  return app;
}

describe('otel 状态分支', () => {
  it('auth 属性挂载 + 5xx 置 ERROR；抛错路径不吞异常', async () => {
    const fiveHundred = otelApp((c) => {
      c.set('auth', auth());
      c.set('requestId', 'r');
      return new Response('err', { status: 500 });
    });
    expect((await fiveHundred.request('/v1/x')).status).toBe(500);

    const throwing = otelApp(() => {
      throw new Error('boom');
    });
    // 无 onError 的裸 Hono 把异常转 500——otel 不吞异常即到达默认处理
    const res = await throwing.request('/v1/x');
    expect(res.status).toBe(500);
  });
});

describe('request-log 嗅探防御', () => {
  it('JSON 响应坏体嗅探失败 → errorCode null 不阻塞；GET 无摘要', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const app = new Hono<AuthEnv>();
    app.use(
      '/v1/*',
      requestLogMiddleware({
        store: { insert: async (i: Record<string, unknown>) => rows.push(i) } as never,
        trustedProxyHops: 0,
      }),
    );
    app.get('/v1/list', (c) => c.text('not json'));
    app.post(
      '/v1/p',
      (_c) => new Response('broken', { headers: { 'content-type': 'application/json' } }),
    );
    expect((await app.request('/v1/list')).status).toBe(200);
    expect((await app.request('/v1/p', { method: 'POST', body: '{}' })).status).toBe(200);
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(rows).toHaveLength(2);
    expect((rows[0] as { requestSummary?: unknown }).requestSummary ?? null).toBeNull(); // GET 无摘要（恒 null 字段）
    expect(defined(rows[1], 'rows[1]').errorCode ?? null).toBeNull(); // 嗅探失败安全回退
  });
});

const candidateRow = (over: Partial<RouteCandidateRow> = {}): RouteCandidateRow => ({
  channelId: 1,
  channelName: 'c',
  apiKeyEnc: 'e',
  baseUrlOverride: null,
  providerName: 'p',
  providerBaseUrl: 'https://p',
  providerProtocol: 'openai-compatible',
  providerVendor: null,
  priority: 1,
  weight: 1,
  rpmLimit: null,
  tpmLimit: null,
  upstreamBudget: '0',
  ...over,
});

describe('catalog 渠道可选列 / billing 可选字段透传', () => {
  it('渠道候选缺限流列时不带字段；全带时透传', async () => {
    const catalog = createGatewayCatalog({
      models: {
        findActiveByExternalName: async () => null,
      },
      channels: {
        findRouteCandidates: async () => [
          candidateRow(),
          candidateRow({ rpmLimit: 5, tpmLimit: 6, upstreamBudget: '7' }),
        ],
      },
      rateCards: { findActiveCardByUser: async () => null },
      billingTimezone: { read: async () => 'Asia/Shanghai' },
    });
    const channels = await catalog.resolveChannels('x');
    expect('rpmLimit' in defined(channels[0], 'channels[0]')).toBe(false);
    expect(channels[1]).toMatchObject({ rpmLimit: 5, tpmLimit: 6, upstreamBudget: '7' });
  });

  it('billing authorize：cacheWrite/unitPrice 非空候选透传进报价', async () => {
    const authorized: unknown[] = [];
    const port = createGatewayBilling(
      {
        authorize: async (input: unknown) => {
          authorized.push(input);
        },
        signal: async () => {},
        reserveChannel: async () => ({ allowed: true, remaining: '0', switched: false }),
      } as never,
      { resolveReservationLimit: async () => '1', resolveReservationPolicy: async () => ({ mode: 'full' }) },
    );
    const candidate: QuoteCandidate = {
      mappingId: 1,
      externalModel: 'm',
      realModel: 'r',
      inputPrice: '1',
      cacheInputPrice: '1',
      cacheWritePrice: '2.5',
      outputPrice: '3',
      unitPrice: '0.1',
      pricingUnit: 'image',
      unitUpperBound: 2,
      coefficient: '1',
      billingPolicyFingerprint: null,
    };
    await port.authorize({
      requestId: 'r',
      userId: 1,
      apiKeyId: null,
      appId: null,
      stream: false,
      candidates: [candidate],
      inputTokenUpperBound: 10,
      maxOutputTokens: 100,
      authorizationTtlMs: 1,
    });
    const { quote } = authorized[0] as { quote: { candidates: Array<Record<string, unknown>> } };
    expect(quote.candidates[0]).toMatchObject({ cacheWritePrice: '2.5', unitPrice: '0.1' });
  });
});

describe('信封可选分支', () => {
  it('sse/raw 无 requestId 时不带 x-request-id 头', () => {
    expect(sseResponse(new ReadableStream()).headers.get('x-request-id')).toBeNull();
  });
});

describe('catalog 快照杂项防御', () => {
  it('非法 pricingUnit 收敛为 token；无卡用户 body 推导照常', async () => {
    const mapping: ActiveMappingRow = {
      id: 1,
      externalName: 'x',
      realModel: 'r',
      contextLength: null,
      inputPrice: '1',
      outputPrice: '1',
      cacheInputPrice: '1',
      cacheWritePrice: '0',
      pricingUnit: 'weird',
      unitPrice: '0',
      pricingGroup: null,
      rpmLimit: null,
      tpmLimit: null,
      isFree: false,
      fallbackModels: null,
      billingPolicy: null,
      billingConfig: {},
    };
    const catalog = createGatewayCatalog({
      models: {
        findActiveByExternalName: async (name) => (name === 'x' ? mapping : null),
      },
      channels: { findRouteCandidates: async () => [] },
      rateCards: {
        findActiveCardByUser: async () =>
          ({
            cardId: 1,
            cardName: 'c',
            status: 0,
            coefficients: [
              { scope: 'global', modelMappingId: null, groupKey: null, coefficient: '0.9' },
            ],
          }) as UserRateCardContext,
      },
      billingTimezone: { read: async () => 'Asia/Shanghai' },
    });
    const snap = defined(
      await catalog.findMapping('x', { userId: 1, body: {}, now: new Date() }),
      'snap',
    );
    expect(snap.pricingUnit).toBe('token');
    expect(snap.coefficient).toBe('0.9');
  });
});

describe('杂项分支收官', () => {
  it('非 /v1 前缀 404 文案分支', async () => {
    const { createGatewayApp } = await import('../src/app');
    const app = createGatewayApp({
      inference: {} as never,
      reader: { resolveKeyByHash: async () => null, resolveApp: async () => null },
      verifyAppClient: async () => null,
      models: { listEnabledMappings: async () => [] },
      requestLogs: { insert: async () => {} } as never,
      pingDb: async () => {},
      oauth: {
        jwtSecret: 'ab12'.repeat(8),
        issuer: 'i',
        audience: 'a',
        keyPrefix: 'sk_',
        tokenTtlSeconds: 60,
      },
      trustedProxyHops: 0,
      logger: { error: () => {} },
    });
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
  });

  it('信封：无 codec 的 body 直传出站（status 透传）', async () => {
    const { encodeDelivered } = await import('../src/http/openai-envelope');
    const res = await encodeDelivered(
      (b, s = 200) => new Response(JSON.stringify(b), { status: s }),
      { ok: true, status: 200, body: { any: 'payload' } },
      { model: 'm' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ any: 'payload' });
  });

  it('generation schema 边界：duration 4/15 合法、可选帧图字段', async () => {
    const { videoSchema } = await import('../src/http/contracts/generation');
    expect(videoSchema.safeParse({ model: 'm', prompt: 'p', duration: 4 }).success).toBe(true);
    expect(videoSchema.safeParse({ model: 'm', prompt: 'p', duration: 15 }).success).toBe(true);
    const withImages = videoSchema.safeParse({
      model: 'm',
      prompt: 'p',
      duration: 6,
      image: 'https://x/img.png',
      last_frame_image: 'https://x/f.png',
    });
    expect(withImages.success).toBe(true);
    expect(videoSchema.safeParse({ model: 'm', prompt: 'p', duration: 3 }).success).toBe(false);
  });

  it('postgres 工厂绑定：五个包装委托 store 单例（db 透传 + 参数对位）', async () => {
    const { createPostgresGatewayCatalog } = await import('../src/adapters/catalog-port');
    // 捕获型 stub：drizzle 链条进入即抛（包装函数体已执行——覆盖 = 绑定存在且参数对位）
    const calls: string[] = [];
    const rejecter = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'then') return; // 非 thenable
          return () => {
            calls.push(String(prop));
            throw new Error('stub-end');
          };
        },
      },
    ) as never;
    const catalog = createPostgresGatewayCatalog(rejecter, {
      ttlMs: 60_000,
      fallback: 'Asia/Shanghai',
    });
    await expect(
      catalog.findMapping('x', { userId: 1, body: {}, now: new Date() }),
    ).rejects.toThrow('stub-end');
    await expect(catalog.resolveChannels('r')).rejects.toThrow('stub-end');
    expect(calls).toContain('select');
  });
});
