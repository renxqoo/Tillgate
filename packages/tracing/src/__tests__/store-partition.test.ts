import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { ensureDailyPartition, maintainPartitions, dayKey } from '../partition.js';
import { createPgTraceStore } from '../store.js';
import type { SpanRow } from '../types.js';

/**
 * store + partition 集成测试（真 PG）。
 * 数据纪律：traceId/spanId 用 `trt-` 前缀随机 hex，清理只删本前缀 + 只 drop 自己建的分区。
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

function spanRow(overrides: Partial<SpanRow> = {}): SpanRow {
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const start = new Date();
  return {
    traceId: randomUUID().replace(/-/g, ''), // 纯 hex（点查校验要求）；测试身份靠 service 列
    spanId,
    parentSpanId: null,
    name: `trt-span-${spanId.slice(0, 6)}`,
    service: 'trt-test-svc',
    startTime: start,
    endTime: new Date(start.getTime() + 150),
    durationMs: 150,
    statusCode: 0,
    statusMessage: null,
    requestId: `trt-req-${spanId.slice(0, 8)}`,
    userId: 1,
    channel: 'trt-ch',
    model: 'trt-model',
    attributes: { 'trt.marker': 'trt' },
    events: [],
    ...overrides,
  };
}

async function cleanup(): Promise<void> {
  await db.execute(sql`delete from trace_spans where service = 'trt-test-svc'`);
  // 拓扑用例的行 service='gateway'，按测试渠道白名单清（不碰真实渠道数据）
  await db.execute(sql`delete from trace_spans where service = 'gateway' and channel in ('ch-a', 'ch-b')`);
}

describe('PgTraceStore（真 PG）', () => {
  it('写入→按 traceId/requestId 查询→recent 聚合→幂等重写不重复', async (context) => {
    if (!connected) return context.skip();
    await cleanup();
    const store = createPgTraceStore(db);
    // start_time 错开毫秒：findByTraceId 仅按 startTime 排序，同毫秒时顺序未定义
    const root = spanRow({ startTime: new Date(Date.now() - 2) });
    const child = spanRow({
      traceId: root.traceId,
      parentSpanId: root.spanId,
      statusCode: 2,
      requestId: root.requestId, // 同一请求的 span 共享 requestId（计费关联口径）
      startTime: new Date(Date.now() - 1),
    });
    const other = spanRow();

    const written = await store.writeBatch([root, child, other]);
    expect(written).toBe(3);
    // 主键冲突忽略（SDK 重发）
    const again = await store.writeBatch([root]);
    expect(again).toBe(0);

    const byTrace = await store.findByTraceId(root.traceId);
    expect(byTrace).toHaveLength(2);
    expect(byTrace[0]!.parentSpanId).toBeNull();
    expect(byTrace[1]!.parentSpanId).toBe(root.spanId);

    const byRequest = await store.findByRequestId(root.requestId!);
    expect(byRequest).toHaveLength(2);

    const recent = await store.findRecentTraces({ service: 'trt-test-svc', limit: 10 });
    const mine = recent.filter((t) => t.services.includes('trt-test-svc'));
    const target = mine.find((t) => t.traceId === root.traceId);
    expect(target).toBeDefined();
    expect(target!.spanCount).toBe(2);
    expect(target!.hasError).toBe(true);
    expect(target!.requestId).toBe(root.requestId);

    const errorsOnly = await store.findRecentTraces({ service: 'trt-test-svc', errorsOnly: true });
    expect(errorsOnly.every((t) => t.hasError)).toBe(true);
    await cleanup();
  });

  it('stats 反映行数与分区列表', async (context) => {
    if (!connected) return context.skip();
    const store = createPgTraceStore(db);
    const stats = await store.stats();
    expect(stats.partitions.length).toBeGreaterThan(0); // 写入用例已建当天分区
    expect(stats.spans).toBeGreaterThanOrEqual(0);
  });
});

describe('分区维护（真 PG）', () => {
  it('ensure 幂等；maintain 预建未来分区并清理超期分区', async (context) => {
    if (!connected) return context.skip();
    const today = dayKey(new Date());
    // 造一个 10 天前的过期分区（测试自建自清）
    const oldDay = dayKey(new Date(Date.now() - 10 * 86_400_000));
    await ensureDailyPartition(db, oldDay);
    await ensureDailyPartition(db, today);
    await ensureDailyPartition(db, today); // 幂等

    const result = await maintainPartitions(db, { retentionDays: 7, lookaheadDays: 1 });
    // 今天/明天已在（created 可能为空），过期分区被清
    expect(result.dropped).toContain(oldDay);
    expect(result.dropped).not.toContain(today);
    // 旧分区确已删除
    const left = await db.execute<{ relname: string }>(
      sql`select relname from pg_class where relname = ${'trace_spans_p' + oldDay}`,
    );
    expect(left.rows).toHaveLength(0);
  });
});

describe('渠道健康拓扑（真 PG）', () => {
  it('按渠道聚合尝试/错误/均延迟/最近错误', async (context) => {
    if (!connected) return context.skip();
    await cleanup();
    const store = createPgTraceStore(db);
    const base = Date.now() - 1_000;
    await store.writeBatch([
      spanRow({ name: 'upstream p1', service: 'gateway', channel: 'ch-a', statusCode: 0, startTime: new Date(base), endTime: new Date(base + 100) }),
      spanRow({ name: 'upstream p1', service: 'gateway', channel: 'ch-a', statusCode: 2, statusMessage: 'rate_limited', startTime: new Date(base + 1000), endTime: new Date(base + 1300) }),
      spanRow({ name: 'upstream p2', service: 'gateway', channel: 'ch-b', statusCode: 0, startTime: new Date(base + 2000), endTime: new Date(base + 2500) }),
      // 窗口外不计入
      spanRow({ name: 'upstream p1', service: 'gateway', channel: 'ch-a', statusCode: 0, startTime: new Date(base - 48 * 3_600_000) }),
    ]);
    const topo = await store.channelTopology(Date.now() - 3_600_000);
    const a = topo.find((t) => t.channel === 'ch-a');
    const b = topo.find((t) => t.channel === 'ch-b');
    expect(a).toBeDefined();
    expect(a!.attempts).toBe(2);
    expect(a!.errors).toBe(1);
    expect(a!.avgDurationMs).toBe(200);
    expect(a!.lastError).toBe('rate_limited');
    expect(b!.attempts).toBe(1);
    expect(b!.errors).toBe(0);
    await cleanup();
  });
});
