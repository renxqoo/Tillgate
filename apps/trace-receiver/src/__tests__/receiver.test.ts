import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { createPgTraceStore, type SpanRow, type TraceStore } from '@ai-gateway/tracing';
import { SpanBatcher } from '../batcher.js';
import { createReceiverApp } from '../app.js';

/**
 * 接收端（真 PG 集成）：
 *   - token 门控 401 / protobuf 415 / 坏 JSON 400 / 结构错误 400
 *   - 合法 OTLP JSON → 202 → flush 后落库可查（计费关联提升列）
 *   - batcher：定量触发、满丢最旧计数、写失败丢弃计数不抛
 * 数据纪律：service=trr-test-svc 前缀，清理只删该前缀。
 */

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
);
let connected = false;

beforeAll(async () => {
  try {
    await db.execute(sql`select 1`);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

function otlpPayload(overrides: { requestId?: string; service?: string } = {}): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: overrides.service ?? 'gateway' } }],
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
                  { key: 'request.id', value: { stringValue: overrides.requestId ?? `trr-req-${randomUUID().slice(0, 8)}` } },
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

describe('接收端 HTTP 面（真 PG）', () => {
  it('token 门控：配置后无/错令牌 401，正确令牌放行', async (context) => {
    if (!connected) return context.skip();
    await db.execute(sql`delete from trace_spans where service = 'trr-test-svc'`);
    const store = createPgTraceStore(db);
    const batcher = new SpanBatcher(store, { max: 1000, batchMax: 500, flushIntervalMs: 60_000 });
    const app = createReceiverApp({ db, store, token: 't'.repeat(24), batcher });

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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${'t'.repeat(24)}` },
      body: JSON.stringify(otlpPayload({ service: 'trr-test-svc' })),
    });
    expect(ok.status).toBe(202);
  });

  it('protobuf → 415；坏 JSON → 400；缺 resourceSpans → 400', async (context) => {
    if (!connected) return context.skip();
    const store = createPgTraceStore(db);
    const batcher = new SpanBatcher(store, { max: 1000, batchMax: 500, flushIntervalMs: 60_000 });
    const app = createReceiverApp({ db, store, batcher });

    const proto = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: '\x08\x01',
    });
    expect(proto.status).toBe(415);
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
    expect(((await badShape.json()) as { error: { code: string } }).error.code).toBe('INVALID_OTLP');
  });

  it('端到端：POST OTLP → flush → request_id 点查命中（计费关联列）', async (context) => {
    if (!connected) return context.skip();
    await db.execute(sql`delete from trace_spans where service = 'trr-test-svc'`);
    const store = createPgTraceStore(db);
    const batcher = new SpanBatcher(store, { max: 1000, batchMax: 1, flushIntervalMs: 60_000 });
    const app = createReceiverApp({ db, store, batcher });

    const requestId = `trr-req-${randomUUID().slice(0, 8)}`;
    const res = await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(otlpPayload({ requestId, service: 'trr-test-svc' })),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { accepted: number }).accepted).toBe(1);
    // batchMax=1 → push 即 flush
    await vi.waitFor(
      async () => {
        const rows = await store.findByRequestId(requestId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.userId).toBe(7);
      },
      { timeout: 3_000, interval: 25 },
    );
    await db.execute(sql`delete from trace_spans where service = 'trr-test-svc'`);
  });
});

function row(n: number): SpanRow {
    const start = new Date(1_700_000_000_000 + n);
    return {
      traceId: 'a'.repeat(32),
      spanId: String(n).padStart(16, '0'),
      parentSpanId: null,
      name: `span-${n}`,
      service: 'trr-test-svc',
      startTime: start,
      endTime: new Date(start.getTime() + 10),
      durationMs: 10,
      statusCode: 0,
      statusMessage: null,
      requestId: null,
      userId: null,
      channel: null,
      model: null,
      attributes: {},
    events: [],
  };
}

describe('SpanBatcher（纯单测）', () => {
  it('队列满丢最旧并计数；不反压调用方', async () => {
    const writeBatch = vi.fn(async () => 1);
    const batcher = new SpanBatcher({ writeBatch } as unknown as TraceStore, {
      max: 5,
      batchMax: 100,
      flushIntervalMs: 60_000,
    });
    const dropped = batcher.push([row(1), row(2), row(3), row(4), row(5), row(6), row(7)]);
    expect(dropped).toBe(2);
    const stats = batcher.getStats();
    expect(stats.received).toBe(7);
    expect(stats.droppedOverflow).toBe(2);
    expect(stats.queueDepth).toBe(5);
  });

  it('写失败丢弃整批并计数，不抛出', async () => {
    const writeBatch = vi.fn(async () => {
      throw new Error('pg down');
    });
    const batcher = new SpanBatcher({ writeBatch } as unknown as TraceStore, {
      max: 100,
      batchMax: 10,
      flushIntervalMs: 60_000,
    });
    batcher.push([row(1), row(2)]);
    await batcher.flush();
    const stats = batcher.getStats();
    expect(stats.droppedWriteError).toBe(2);
    expect(stats.flushed).toBe(0);
    expect(stats.lastError).toContain('pg down');
  });
});
