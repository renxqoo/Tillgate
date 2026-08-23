import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  SpanBatcher,
  BatcherStats,
  TraceStore,
  TraceStoreStats,
} from '@tokenlens/observability';
import { createReceiverApp } from '../src/app';

/**
 * 接收端 HTTP 面单测(零 PG):鉴权门/媒体类型门/错误信封码/202 计数算术/探活与指标。
 * 真 PG 端到端(写路径排空/幂等)在 receiver.real.test.ts——两文件合起来是 v1
 * receiver.test.ts HTTP 面段(4 用例)的行为规格超集。
 */

const TOKEN = 't'.repeat(24);

/** DB 探活闭包:app 依赖面只收函数,不出现 Db 类型(P5) */
const pingDbOk = () => Promise.resolve();
const pingDbFail = () => Promise.reject(new Error('connection refused'));

function fakeBatcher(droppedOverflow = 0): SpanBatcher & { pushed: unknown[][] } {
  const pushed: unknown[][] = [];
  const stats: BatcherStats & { queueDepth: number } = {
    received: 3,
    queued: 0,
    flushed: 0,
    droppedOverflow,
    droppedWriteError: 0,
    lastError: null,
    lastFlushAt: null,
    queueDepth: 2,
  };
  return {
    pushed,
    start: vi.fn(),
    push: vi.fn((rows) => {
      pushed.push(rows);
      return droppedOverflow;
    }),
    flush: vi.fn(async () => undefined),
    getStats: () => stats,
    close: vi.fn(async () => undefined),
  } as unknown as SpanBatcher & { pushed: unknown[][] };
}

function fakeStore(statsImpl: () => Promise<TraceStoreStats>): TraceStore {
  return { stats: statsImpl } as unknown as TraceStore;
}

const STORE_STATS: TraceStoreStats = {
  rows: 42,
  oldestDay: '2026-08-01',
  partitions: ['p1'],
} as unknown as TraceStoreStats;

/** OTLP 载荷:n 个合法 span + 1 个畸形 span(坏 hex traceId → decode 跳过计数) */
function otlpPayload(goodSpans: number): unknown {
  const spans = Array.from({ length: goodSpans }, () => ({
    traceId: randomUUID().replace(/-/g, ''),
    spanId: randomUUID().replace(/-/g, '').slice(0, 16),
    name: 'POST /v1/chat/completions',
    startTimeUnixNano: String(Date.now() * 1_000_000),
    endTimeUnixNano: String((Date.now() + 120) * 1_000_000),
    attributes: [
      { key: 'request.id', value: { stringValue: `req-${randomUUID().slice(0, 8)}` } },
      { key: 'user.id', value: { intValue: 7 } },
    ],
    status: { code: 1 },
  }));
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'trr-unit-svc' } }] },
        scopeSpans: [{ spans: [...spans, { traceId: 'NOT-HEX!', spanId: 'x', name: 'bad' }] }],
      },
    ],
  };
}

describe('鉴权门(令牌配置后)', () => {
  it('无/错令牌 401(http.unauthorized);正确令牌放行到路由', async () => {
    const app = createReceiverApp({
      pingDb: pingDbOk,
      store: fakeStore(async () => STORE_STATS),
      batcher: fakeBatcher(),
      token: TOKEN,
    });
    const noToken = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(otlpPayload(1)),
    });
    expect(noToken.status).toBe(401);
    expect(((await noToken.json()) as { error: { code: string } }).error.code).toBe(
      'http.unauthorized',
    );

    const badToken = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token-value!' },
      body: JSON.stringify(otlpPayload(1)),
    });
    expect(badToken.status).toBe(401);

    const ok = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(otlpPayload(1)),
    });
    expect(ok.status).toBe(202);
  });

  it('未配置令牌(开发内网)放行;探针路径豁免鉴权', async () => {
    const app = createReceiverApp({
      pingDb: pingDbOk,
      store: fakeStore(async () => STORE_STATS),
      batcher: fakeBatcher(),
    });
    const open = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(otlpPayload(1)),
    });
    expect(open.status).toBe(202);

    const gated = createReceiverApp({
      pingDb: pingDbOk,
      store: fakeStore(async () => STORE_STATS),
      batcher: fakeBatcher(),
      token: TOKEN,
    });
    const readyz = await gated.request('/readyz'); // 不带 Bearer
    expect(readyz.status).toBe(200);
    const livez = await gated.request('/livez'); // 豁免但未建路由 → 404(v1 同形)
    expect(livez.status).toBe(404);
  });
});

describe('媒体类型与载荷门', () => {
  const deps = () => ({
    pingDb: pingDbOk,
    store: fakeStore(async () => STORE_STATS),
    batcher: fakeBatcher(),
  });

  it('protobuf → 415 且 context 带改配提示(OTLP SDK 缺省即 protobuf,最常见接入错误)', async () => {
    const app = createReceiverApp(deps());
    const res = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: '\x08\x01',
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as {
      error: { code: string; context?: Record<string, string> };
    };
    expect(body.error.code).toBe('http.unsupported_media_type');
    expect(body.error.context?.hint).toContain('http/json');
  });

  it('非 JSON content-type → 415;坏 JSON 体 → 400 http.invalid_json', async () => {
    const app = createReceiverApp(deps());
    const plain = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect(plain.status).toBe(415);
    const badJson = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: { code: string } }).error.code).toBe(
      'http.invalid_json',
    );
  });

  it('结构非法 OTLP(缺 resourceSpans) → 400 observability.invalid_otlp_payload(G6 映射)', async () => {
    const app = createReceiverApp(deps());
    const res = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 1 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'observability.invalid_otlp_payload',
    );
  });

  it('>8MB 请求体 → 413 http.payload_too_large(超限在解析前拒绝,不整读)', async () => {
    const app = createReceiverApp(deps());
    const res = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(9 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'http.payload_too_large',
    );
  });
});

describe('接收与指标', () => {
  it('202 计数算术:accepted = rows - droppedOverflow,skippedMalformed 透传', async () => {
    const batcher = fakeBatcher(1); // 模拟队列溢出丢 1
    const app = createReceiverApp({
      pingDb: pingDbOk,
      store: fakeStore(async () => STORE_STATS),
      batcher,
    });
    const res = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(otlpPayload(2)), // 2 合法 + 1 畸形
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, skippedMalformed: 1, droppedOverflow: 1 });
    expect(batcher.pushed).toHaveLength(1);
    expect(batcher.pushed[0]).toHaveLength(2); // 只入队合法行
  });

  it('/readyz:DB 可达 up;不可达 503 down(v1 探活形状)', async () => {
    const up = createReceiverApp({
      pingDb: pingDbOk,
      store: fakeStore(async () => STORE_STATS),
      batcher: fakeBatcher(),
    });
    const upRes = await up.request('/readyz');
    expect(upRes.status).toBe(200);
    expect(await upRes.json()).toEqual({ status: 'ok', dependencies: { postgres: 'up' } });

    const down = createReceiverApp({
      pingDb: pingDbFail,
      store: fakeStore(async () => STORE_STATS),
      batcher: fakeBatcher(),
    });
    const downRes = await down.request('/readyz');
    expect(downRes.status).toBe(503);
    expect(
      ((await downRes.json()) as { status: string; dependencies: { postgres: string } })
        .dependencies.postgres,
    ).toBe('down');
  });

  it('/internal/stats:batcher 计数器直出;存储查询失败不掩盖指标(storage null)', async () => {
    const batcher = fakeBatcher();
    const ok = createReceiverApp({
      pingDb: pingDbOk,
      store: fakeStore(async () => STORE_STATS),
      batcher,
    });
    const okRes = await ok.request('/internal/stats');
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ batcher: batcher.getStats(), storage: STORE_STATS });

    const failing = createReceiverApp({
      pingDb: pingDbOk,
      store: fakeStore(async () => {
        throw new Error('pg down');
      }),
      batcher,
    });
    const failRes = await failing.request('/internal/stats');
    expect(failRes.status).toBe(200);
    expect(((await failRes.json()) as { storage: unknown }).storage).toBeNull();
  });
});
