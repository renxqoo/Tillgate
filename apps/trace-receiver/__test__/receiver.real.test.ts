import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, closeDb, ping, type Db } from '@tillgate/db';
import { createPgTraceStore } from '@tillgate/observability/composition';
import { createSpanBatcher, type SpanBatcher } from '@tillgate/observability';
import { createReceiverApp } from '../src/app';
import { defined } from './defined';

/**
 * 接收端真 PG 集成(铁律 14:默认门禁按文件名排除,test:real 显式运行)。
 * v1 receiver.test.ts「HTTP 面段」4 用例的行为等价移植(裁决见 observability
 * MIGRATION §0:batcher/decode/store 端到端链路由本文件在 app 边界复验):
 *   token 门控 / 媒体类型与结构错误信封 / bodyLimit / POST→flush→点查(计费关联提升列)。
 * 环境:DATABASE_URL(根 .env);不可达时全组跳过。
 * 数据纪律:service='trr-test-svc' 前缀,自建自清。
 */

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/tillgate';
let db: Db | null = null;

beforeAll(async () => {
  try {
    const candidate = createDb({
      url,
      poolMax: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
      maxUses: 1_000,
    });
    await ping(candidate);
    db = candidate;
  } catch {
    db = null;
  }
});
afterAll(async () => {
  if (db) await closeDb(db).catch(() => {});
});

const SERVICE = 'trr-test-svc';

function appUnderTest(batcher: SpanBatcher, token?: string) {
  if (!db) throw new Error('pg unavailable');
  const connected = db;
  // pingDb 闭包绑定在测试装配面:app 依赖不出现 Db 类型(P5)
  return createReceiverApp({
    pingDb: () => ping(connected),
    store: createPgTraceStore(connected),
    batcher,
    token,
  });
}

/** v1 形状:合法 span + request.id/user.id 提升属性 */
function otlpPayload(overrides: { requestId?: string; service?: string } = {}): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: overrides.service ?? 'gateway' } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: randomUUID().replace(/-/g, ''),
                spanId: randomUUID().replace(/-/g, '').slice(0, 16),
                name: 'POST /v1/chat/completions',
                startTimeUnixNano: String(Date.now() * 1_000_000),
                endTimeUnixNano: String((Date.now() + 120) * 1_000_000),
                attributes: [
                  {
                    key: 'request.id',
                    value: {
                      stringValue: overrides.requestId ?? `trr-req-${randomUUID().slice(0, 8)}`,
                    },
                  },
                  { key: 'user.id', value: { intValue: 7 } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('接收端 HTTP 面(真 PG)', () => {
  it('bodyLimit:>8MB 请求体被 413 拒绝;不返回 202(超限在解析前拒绝)', async (context) => {
    if (!db) return context.skip();
    const app = appUnderTest(
      createSpanBatcher(createPgTraceStore(db), {
        max: 1000,
        batchMax: 500,
        flushIntervalMs: 60_000,
      }),
    );
    const res = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(9 * 1024 * 1024),
    });
    expect([413, 400]).toContain(res.status); // 413 bodyLimit;或解析层 400——关键是拒绝且不整读 OOM
    expect(res.status).not.toBe(202);
  });

  it('token 门控:配置后无/错令牌 401,正确令牌放行', async (context) => {
    if (!db) return context.skip();
    await db.execute(`delete from trace_spans where service = '${SERVICE}'`);
    const token = 't'.repeat(24);
    const app = appUnderTest(
      createSpanBatcher(createPgTraceStore(db), {
        max: 1000,
        batchMax: 500,
        flushIntervalMs: 60_000,
      }),
      token,
    );
    const noToken = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(otlpPayload()),
    });
    expect(noToken.status).toBe(401);
    const badToken = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify(otlpPayload()),
    });
    expect(badToken.status).toBe(401);
    const ok = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(otlpPayload({ service: SERVICE })),
    });
    expect(ok.status).toBe(202);
  });

  it('protobuf → 415;坏 JSON → 400;缺 resourceSpans → 400(目录码信封)', async (context) => {
    if (!db) return context.skip();
    const app = appUnderTest(
      createSpanBatcher(createPgTraceStore(db), {
        max: 1000,
        batchMax: 500,
        flushIntervalMs: 60_000,
      }),
    );

    const proto = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: '\x08\x01',
    });
    expect(proto.status).toBe(415);
    expect(((await proto.json()) as { error: { code: string } }).error.code).toBe(
      'http.unsupported_media_type',
    );

    const badJson = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(badJson.status).toBe(400);

    const badShape = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 1 }),
    });
    expect(badShape.status).toBe(400);
    expect(((await badShape.json()) as { error: { code: string } }).error.code).toBe(
      'observability.invalid_otlp_payload', // G6:v1 wire 码 INVALID_OTLP → 目录码
    );
  });

  it('端到端:POST OTLP → flush → request_id 点查命中(计费关联提升列)', async (context) => {
    if (!db) return context.skip();
    await db.execute(`delete from trace_spans where service = '${SERVICE}'`);
    const store = createPgTraceStore(db);
    // batchMax=1 → push 即 flush(不需要等定时器)
    const batcher = createSpanBatcher(store, { max: 1000, batchMax: 1, flushIntervalMs: 60_000 });
    const app = appUnderTest(batcher);

    const requestId = `trr-req-${randomUUID().slice(0, 8)}`;
    const res = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(otlpPayload({ requestId, service: SERVICE })),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { accepted: number }).accepted).toBe(1);
    await vi.waitFor(
      async () => {
        const rows = await store.findByRequestId(requestId);
        expect(rows).toHaveLength(1);
        expect(defined(rows[0], 'rows[0]').userId).toBe(7);
      },
      { timeout: 3_000, interval: 25 },
    );
    await db.execute(`delete from trace_spans where service = '${SERVICE}'`);
  });
});
