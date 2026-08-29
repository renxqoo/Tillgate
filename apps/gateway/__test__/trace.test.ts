/**
 * 全链路 span 树（用户可见行为规格）：一次 /v1/chat/completions 请求在 memory 模式
 * OTel 下产生完整请求路径 span——至少 9 步、同一 traceId、挂于 HTTP 根 span 之下。
 * 装配与生产同构：真实 createInference +
 * adapters/trace-port OTel 绑定；目录/计费/上游/限流为内存替身。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UpstreamError, type Ai } from '@tillgate/ai';
import {
  createInference,
  createMemoryHealthStore,
  type BillingPort,
  type CatalogPort,
  type ChannelCandidate,
  type ModelMappingSnapshot,
  type UpstreamPort,
} from '@tillgate/inference';
import type { SlidingWindowLimiter } from '@tillgate/runtime';
import type { RequestLogStore } from '@tillgate/observability';
import { initOtel } from '@tillgate/observability';
import type { ViewableSpan, ViewableTrace } from '@tillgate/observability';
import { createGatewayApp } from '../src/app';
import { otelTracePort } from '../src/adapters/trace-port';
import { defined } from './defined';
import type { RateLimitGate } from '../src/http/middleware/rate-limit';

let otel: ReturnType<typeof initOtel>;

// memory 查看器访问辅助（模块级：本套件固定 mode=memory 装配，缺失即环境装配错误；
// 同时避免 it 回调内再嵌多层箭头函数触发 max-nested-callbacks）
function memoryRecent(): ViewableTrace[] {
  return defined(otel.memory, 'otel.memory').recent();
}

// span 名 → span 索引（同上提模块级）
function spanIndex(traces: ViewableTrace[]): Record<string, ViewableSpan> {
  return Object.fromEntries(traces.flatMap((t) => t.spans.map((s) => [s.name, s] as const)));
}

const mapping: ModelMappingSnapshot = {
  mappingId: 11,
  externalModel: 'gpt-x',
  realModel: 'gpt-x-real',
  fallbackModels: [],
  inputPrice: '2',
  cacheInputPrice: '1',
  cacheWritePrice: null,
  outputPrice: '8',
  unitPrice: null,
  pricingUnit: 'token',
  unitUpperBound: 0,
  coefficient: '1',
  billingPolicyFingerprint: 'fp-1',
};
const channelA: ChannelCandidate = {
  channelId: 7,
  channelName: 'ch-7',
  providerName: 'prov',
  protocol: 'openai-compatible',
  vendor: null,
  baseUrl: 'https://up.example.com/v1',
  apiKeyEnc: 'enc-7',
  upstreamModel: 'gpt-x-real',
  priority: 0,
  weight: 1,
};

const catalog: CatalogPort = {
  findMapping: async () => mapping,
  resolveChannels: async () => [channelA],
};
const billing: BillingPort = {
  authorize: async () => {},
  reserveChannel: async () => ({ allowed: true }),
  signal: async () => {},
};
const upstream: UpstreamPort = {
  chat: async (_ch, request) => {
    // 「坏参数」标记 → 上游 4xx（透传路径用例）；其余恒成功
    if (JSON.stringify(request.body).includes('坏参数')) {
      return {
        ok: false,
        error: new UpstreamError({ kind: 'invalid_request', status: 400, message: 'bad' }),
        durationMs: 1,
      };
    }
    return {
      ok: true,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        estimated: false,
        raw: null,
      },
      durationMs: 3,
      body: { id: 'cmpl', choices: [{ message: { role: 'assistant', content: 'ok' } }] },
    };
  },
  chatStream: async () => {
    throw new Error('not used');
  },
  submitTask: async () => ({ ok: true, upstreamTaskId: 'u' }),
  queryTask: async () => ({
    ok: false,
    error: new UpstreamError({ kind: 'upstream_error' }),
  }),
  executeTask: async () => ({
    ok: false,
    error: new UpstreamError({ kind: 'upstream_error' }),
  }),
};

/** 放行限流闸（Redis 语义替身：只验 span 面，不验限流判定——那归 rate-limit.test） */
const rateLimit: RateLimitGate = {
  limiter: {
    check: async () => ({ allowed: true }),
    checkAll: async () => ({ allowed: true }),
    reserveTpmAll: async () => ({ allowed: true }),
    releaseTpm: async () => {},
    renewTpm: async () => {},
    backfillTpm: async () => {},
  } as unknown as SlidingWindowLimiter,
  globalRpm: 1000,
  preauthIpRpm: null,
};

beforeAll(() => {
  otel = initOtel({ serviceName: 'gateway', serviceVersion: 'test', mode: 'memory' });
});

afterAll(async () => {
  await otel.shutdown();
});

function makeApp() {
  const inference = createInference({
    ai: { subscribe: () => () => {} } as unknown as Ai,
    catalog,
    billing,
    store: createMemoryHealthStore(),
    decrypt: (enc) => enc,
    upstream,
    trace: otelTracePort,
  });
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
    requestLogs: { insert: async () => {} } as unknown as RequestLogStore,
    pingDb: async () => {},
    oauth: {
      jwtSecret: 'ab12'.repeat(8),
      issuer: 'i',
      audience: 'a',
      keyPrefix: 'sk_',
      tokenTtlSeconds: 3_600,
    },
    rateLimit,
    trustedProxyHops: 0,
  });
}

describe('adapters/trace-port：OTel 绑定契约', () => {
  it('setAttributes/setStatus 双态映射进真实 span（ok/error 分 span——OTel 语义 OK 后 ERROR 不可覆盖）', async () => {
    otel.memory?.clear();
    await otelTracePort
      .withSpan('tp.ok', { probe: 1 }, async (span) => {
        span.setAttributes({ added: true });
        span.setStatus({ code: 'ok' });
        return 42;
      })
      .then((v) => expect(v).toBe(42));
    await otelTracePort.withSpan('tp.error', {}, async (span) => {
      span.setStatus({ code: 'error', message: 'boom' });
    });
    const byName = spanIndex(memoryRecent());
    expect(defined(byName['tp.ok'], "byName['tp.ok']").attributes).toMatchObject({
      probe: 1,
      added: true,
    });
    expect(defined(byName['tp.ok'], "byName['tp.ok']").status.code).toBe(1); // SpanStatusCode.OK
    expect(defined(byName['tp.error'], "byName['tp.error']").status).toMatchObject({
      code: 2,
      message: 'boom',
    }); // ERROR
  });
});

describe('全链路 span 树（memory OTel + 真实 inference 装配）', () => {
  it('非流式 chat：完整请求路径 ≥9 span，同一 traceId，全部挂 HTTP 根 span 之下', async () => {
    const app = makeApp();
    otel.memory?.clear();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: '你好' }] }),
    });
    expect(res.status).toBe(200);

    const traces = memoryRecent();
    expect(traces).toHaveLength(1);
    const trace = defined(traces[0], 'traces[0]');
    expect(trace.rootName).toBe('POST /v1/chat/completions');
    expect(trace.spanCount).toBeGreaterThanOrEqual(9);

    const names = trace.spans.map((s) => s.name);
    for (const expected of [
      'POST /v1/chat/completions',
      'auth.api_key',
      'rate_limit.admit',
      'inference.prepare',
      'billing.authorize',
      'routing.resolve',
      'billing.reserve_channel',
      'upstream.attempt',
      'billing.settle_signal',
    ]) {
      expect(names, `span ${expected} 缺失，实得：${names.join(', ')}`).toContain(expected);
    }
    // 成树不成散点：除根 span 外全部以根为父（trace 树深度 = 2）
    const root = defined(
      trace.spans.find((s) => s.name === 'POST /v1/chat/completions'),
      'root span',
    );
    for (const span of trace.spans) {
      if (span.spanId === root.spanId) continue;
      expect(span.parentSpanId).toBe(root.spanId);
    }
    // 关键关联锚点：requestId 贯穿根 span 与阶段 span
    const echoed = defined(res.headers.get('x-request-id'), 'x-request-id');
    expect(root.attributes['request.id']).toBe(echoed);
    const prepare = defined(
      trace.spans.find((s) => s.name === 'inference.prepare'),
      'inference.prepare span',
    );
    expect(prepare.attributes['request.id']).toBe(echoed);
  });

  it('上游 4xx：透传路径补 billing.passthrough_4xx span（树仍同 trace）', async () => {
    const app = makeApp();
    otel.memory?.clear();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk_k', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: '坏参数' }] }),
    });
    expect(res.status).toBe(400);
    const trace = defined(memoryRecent()[0], 'trace');
    const names = trace.spans.map((s) => s.name);
    expect(names).toContain('billing.passthrough_4xx');
    expect(names).not.toContain('billing.settle_signal'); // 透传不结算
    const passthrough = defined(
      trace.spans.find((s) => s.name === 'billing.passthrough_4xx'),
      'billing.passthrough_4xx span',
    );
    expect(passthrough.attributes['http.status_code']).toBe(400);
    expect(trace.hasError).toBe(true);
  });
});
