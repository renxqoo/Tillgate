import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { createPgTraceStore } from '@ai-gateway/tracing';
import { users } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { tracingAdminRoutes } from '../tracing.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * 管理台链路查询路由（真 PG 集成）：
 * recent 过滤聚合 / 单 trace 瀑布数据 / request_id 关联（计费复核入口）/ stats。
 * 数据纪律：service=tra-test-svc，清理只删该前缀。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
let connected = false;

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ where: sql`${users.id} = 1`, columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

async function seed(): Promise<{ traceId: string; requestId: string }> {
  const store = createPgTraceStore(db);
  const traceId = randomUUID().replace(/-/g, '');
  const requestId = `tra-req-${randomUUID().slice(0, 8)}`;
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const start = new Date();
  await store.writeBatch([
    {
      traceId,
      spanId,
      parentSpanId: null,
      name: 'POST /v1/chat/completions',
      service: 'tra-test-svc',
      startTime: start,
      endTime: new Date(start.getTime() + 300),
      durationMs: 300,
      statusCode: 0,
      statusMessage: null,
      requestId,
      userId: 1,
      channel: 'tra-ch',
      model: 'tra-model',
      attributes: { 'http.status_code': 200 },
      events: [],
    },
    {
      traceId,
      spanId: randomUUID().replace(/-/g, '').slice(0, 16),
      parentSpanId: spanId,
      name: 'upstream provider',
      service: 'gateway',
      startTime: new Date(start.getTime() + 10),
      endTime: new Date(start.getTime() + 280),
      durationMs: 270,
      statusCode: 2,
      statusMessage: 'upstream failed',
      requestId,
      userId: 1,
      channel: 'tra-ch',
      model: 'tra-model',
      attributes: {},
      events: [],
    },
  ]);
  return { traceId, requestId };
}

describe('管理台链路查询（真 PG）', () => {
  it('recent 聚合 + 单 trace 瀑布 + request_id 关联 + stats', async (context) => {
    if (!connected) return context.skip();
    await db.execute(sql`delete from trace_spans where service = 'tra-test-svc'`);
    const { traceId, requestId } = await seed();
    const app = makeAdminTestApp({ '/tracing': tracingAdminRoutes(makeServices(db)) });
    try {
      // recent：errorsOnly 过滤命中含 ERROR 的 trace（R10 起标准分页 envelope）
      const recent = await app.request('/api/admin/tracing/recent?errorsOnly=true&page=1&page_size=10');
      expect(recent.status).toBe(200);
      const body = (await recent.json()) as {
        list: Array<{ traceId: string; hasError: boolean; spanCount: number; requestId: string | null }>;
        total: number;
        page: number;
        page_size: number;
      };
      expect(body.page).toBe(1);
      expect(body.page_size).toBe(10);
      expect(body.total).toBeGreaterThanOrEqual(1);
      const mine = body.list.find((t) => t.traceId === traceId);
      expect(mine).toBeDefined();
      expect(mine!.hasError).toBe(true);
      expect(mine!.spanCount).toBe(2);
      expect(mine!.requestId).toBe(requestId);

      // 单 trace：span 按时间序 + 汇总
      const detail = await app.request(`/api/admin/tracing/traces/${traceId}`);
      const detailBody = (await detail.json()) as {
        spans: Array<{ name: string; parentSpanId: string | null }>;
        services: string[];
        durationMs: number;
      };
      expect(detail.status).toBe(200);
      expect(detailBody.spans).toHaveLength(2);
      expect(detailBody.spans[0]!.parentSpanId).toBeNull();
      expect(detailBody.services).toContain('gateway');
      expect(detailBody.durationMs).toBeGreaterThanOrEqual(280);

      // request_id 关联（计费复核入口）：与 /traces/:id 同形状的 TraceDetail
      const byRequest = await app.request(`/api/admin/tracing/by-request/${requestId}`);
      const byRequestBody = (await byRequest.json()) as {
        spans: Array<{ traceId: string }>;
        services: string[];
        startMs: number;
        durationMs: number;
      };
      expect(byRequest.status).toBe(200);
      expect(byRequestBody.spans).toHaveLength(2);
      expect(byRequestBody.spans.every((s) => s.traceId === traceId)).toBe(true);
      expect(byRequestBody.services).toContain('tra-test-svc');
      expect(byRequestBody.durationMs).toBeGreaterThanOrEqual(280);
      expect(byRequestBody.startMs).toBeGreaterThan(0);

      // stats
      const stats = await app.request('/api/admin/tracing/stats');
      expect(stats.status).toBe(200);
      expect(((await stats.json()) as { storage: { partitions: string[] } }).storage.partitions
        .length).toBeGreaterThan(0);
    } finally {
      await db.execute(sql`delete from trace_spans where service = 'tra-test-svc'`);
    }
  });
});
