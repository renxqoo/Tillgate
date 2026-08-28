import { describe, expect, it } from 'vitest';
import { createTraceQueries } from '../src/tracing/queries';
import { dayKey, shiftDay } from '../src/tracing/partition';
import { defined } from './defined';
import type { SpanRow, TraceStore } from '../src/tracing/types';

/**
 * 查询信封规格:钳位、rows+total 同过滤、
 * 详情信封、topology hours→sinceMs 正确换算回归。
 */

function span(overrides: Partial<SpanRow> = {}): SpanRow {
  const start = new Date(1_700_000_000_000);
  return {
    traceId: 'a'.repeat(32),
    spanId: 's'.repeat(16),
    parentSpanId: null,
    name: 'root',
    service: 'gateway',
    startTime: start,
    endTime: new Date(start.getTime() + 100),
    durationMs: 100,
    statusCode: 0,
    statusMessage: null,
    requestId: 'req-1',
    userId: 1,
    channel: null,
    model: null,
    attributes: {},
    events: [],
    ...overrides,
  };
}

function recordingStore(calls: { channelTopologySince?: number[] } = {}): TraceStore {
  return {
    async writeBatch() {
      return 0;
    },
    async findRecentTraces(filter) {
      return [
        {
          traceId: 't1',
          rootName: 'root',
          startTimeMs: 1,
          durationMs: 5,
          spanCount: 2,
          hasError: false,
          services: ['gateway'],
          requestId: null,
        },
      ].filter(() => filter.service !== 'none');
    },
    async countRecentTraces() {
      return 42;
    },
    async findByTraceId(traceId) {
      if (traceId !== 'found') return [];
      const first = span();
      const second = span({
        spanId: 'c'.repeat(16),
        startTime: new Date(1_700_000_001_000),
        endTime: new Date(1_700_000_001_100),
        durationMs: 100,
      });
      return [first, second];
    },
    async findByRequestId(requestId) {
      return requestId === 'req-1' ? [span({ requestId })] : [];
    },
    async stats() {
      return { spans: 7, oldestDays: 3, partitions: ['2026-08-23'] };
    },
    async channelTopology(sinceMs) {
      calls.channelTopologySince?.push(sinceMs);
      return [];
    },
  };
}

describe('createTraceQueries', () => {
  it('recent:limit 钳 1..100,rows 与 total 同过滤并行返回', async () => {
    const queries = createTraceQueries(recordingStore());
    const tooBig = await queries.recent({ limit: 999, offset: -5 });
    expect(tooBig.rows).toHaveLength(1);
    expect(tooBig.total).toBe(42);
    const tooSmall = await queries.recent({ limit: 0, offset: 0 });
    expect(tooSmall.rows).toHaveLength(1); // 钳到 1,仍出该行
  });

  it('traceDetail:组装 services/startMs/durationMs;未知 traceId 空兜底', async () => {
    const queries = createTraceQueries(recordingStore());
    const detail = await queries.traceDetail('found');
    expect(detail.spans).toHaveLength(2);
    expect(detail.services).toEqual(['gateway']);
    expect(detail.startMs).toBe(1_700_000_000_000);
    expect(detail.durationMs).toBe(1_100); // max(end) - min(start)
    const empty = await queries.traceDetail('missing');
    expect(empty).toEqual({ spans: [], services: [], startMs: 0, durationMs: 0 });
  });

  it('byRequest:按 requestId 点查同信封', async () => {
    const queries = createTraceQueries(recordingStore());
    const detail = await queries.byRequest('req-1');
    expect(detail.spans).toHaveLength(1);
    expect(await queries.byRequest('nope')).toEqual({
      spans: [],
      services: [],
      startMs: 0,
      durationMs: 0,
    });
  });

  it('B8 回归:topology 的 hours 正确换算为 sinceMs(1..168 钳位)', async () => {
    const calls: number[] = [];
    const queries = createTraceQueries(recordingStore({ channelTopologySince: calls }));
    const before = Date.now();
    await queries.topology(24);
    await queries.topology(0); // 钳到 1
    await queries.topology(999); // 钳到 168
    const after = Date.now();
    expect(calls).toHaveLength(3);
    // 历史缺陷:小时数被直接当毫秒时间戳传入(≈1970);修复后应落在「now - hours*3600s」窗内
    const h24 = defined(calls[0], 'h24');
    const h1 = defined(calls[1], 'h1');
    const h168 = defined(calls[2], 'h168');
    expect(h24).toBeGreaterThanOrEqual(after - 24 * 3_600_000 - 50);
    expect(h24).toBeLessThanOrEqual(before - 24 * 3_600_000 + 50);
    expect(h1).toBeGreaterThanOrEqual(after - 3_600_000 - 50);
    expect(h168).toBeGreaterThanOrEqual(after - 168 * 3_600_000 - 50);
  });

  it('stats:透传存储统计', async () => {
    const queries = createTraceQueries(recordingStore());
    expect(await queries.stats()).toEqual({ spans: 7, oldestDays: 3, partitions: ['2026-08-23'] });
  });
});

describe('partition 纯助手', () => {
  it('dayKey 输出 UTC 日;shiftDay 跨月/跨年往返', () => {
    expect(dayKey(new Date('2026-08-23T23:59:59.999Z'))).toBe('2026-08-23');
    expect(shiftDay('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-08-23', -7)).toBe('2026-08-16');
  });
});
