import { describe, expect, it, vi } from 'vitest';
import { createSpanBatcher } from '../src/tracing/ingest';
import type { SpanRow, TraceStore } from '../src/tracing/types';
import { defined } from './defined';

/**
 * SpanBatcher 规格:
 * best-effort 数据等级——溢出丢最旧、写失败丢整批,任何路径不抛、不反压。
 */

function row(traceId: string, spanId: string): SpanRow {
  const start = new Date();
  return {
    traceId,
    spanId,
    parentSpanId: null,
    name: `span-${spanId}`,
    service: 'test',
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

function fakeStore(behavior: { write?: (rows: SpanRow[]) => Promise<number> } = {}): TraceStore & {
  batches: SpanRow[][];
} {
  const batches: SpanRow[][] = [];
  return {
    batches,
    async writeBatch(rows) {
      batches.push(rows);
      if (behavior.write) return behavior.write(rows);
      return rows.length;
    },
    async findRecentTraces() {
      return [];
    },
    async countRecentTraces() {
      return 0;
    },
    async findByTraceId() {
      return [];
    },
    async findByRequestId() {
      return [];
    },
    async stats() {
      return { spans: 0, oldestDays: null, partitions: [] };
    },
    async channelTopology() {
      return [];
    },
  };
}

/** push 触发的 void flush 是异步竞争的;确定性排空:循环 flush 直到队列见底 */
async function drain(batcher: ReturnType<typeof createSpanBatcher>): Promise<void> {
  for (let i = 0; i < 10 && batcher.getStats().queueDepth > 0; i++) {
    await batcher.flush();
  }
}

describe('createSpanBatcher', () => {
  it('队列满丢最旧并计数;不反压调用方', async () => {
    const store = fakeStore();
    const batcher = createSpanBatcher(store, { max: 3, batchMax: 10, flushIntervalMs: 60_000 });
    const dropped = batcher.push([
      row('t', '1'),
      row('t', '2'),
      row('t', '3'),
      row('t', '4'),
      row('t', '5'),
    ]);
    expect(dropped).toBe(2);
    await batcher.flush();
    // 丢最旧:剩下 3/4/5
    expect(defined(store.batches[0], 'batches[0]').map((r) => r.spanId)).toEqual(['3', '4', '5']);
    const stats = batcher.getStats();
    expect(stats.received).toBe(5);
    expect(stats.droppedOverflow).toBe(2);
    expect(stats.flushed).toBe(3);
    expect(stats.lastError).toBeNull();
  });

  it('写失败丢弃整批并计数,不抛出', async () => {
    const store = fakeStore({ write: () => Promise.reject(new Error('pg down')) });
    const batcher = createSpanBatcher(store, { max: 10, batchMax: 10, flushIntervalMs: 60_000 });
    batcher.push([row('t', '1'), row('t', '2')]);
    await batcher.flush();
    const stats = batcher.getStats();
    expect(stats.droppedWriteError).toBe(2);
    expect(stats.flushed).toBe(0);
    expect(stats.lastError).toBe('pg down');
    // 队列已清空(失败即丢,不重试)
    expect(stats.queueDepth).toBe(0);
  });

  it('定量触发:队列达 batchMax 立即 flush;定时器到点 flush 剩余', async () => {
    vi.useFakeTimers();
    try {
      const store = fakeStore();
      const batcher = createSpanBatcher(store, { max: 100, batchMax: 2, flushIntervalMs: 50 });
      batcher.start();
      // 未达 batchMax:入队不刷
      batcher.push([row('t', '1')]);
      expect(store.batches).toHaveLength(0);
      // 达 batchMax:立即刷
      batcher.push([row('t', '2')]);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.batches).toHaveLength(1);
      // 定时到点:剩余队列刷出
      batcher.push([row('t', '3')]);
      await vi.advanceTimersByTimeAsync(50);
      expect(store.batches).toHaveLength(2);
      expect(store.batches[1]).toHaveLength(1);
      // 空队列:定时器空转不产批
      await vi.advanceTimersByTimeAsync(100);
      expect(store.batches).toHaveLength(2);
      await batcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('超过 batchMax 的大批分多次刷完;start 幂等', async () => {
    const store = fakeStore();
    const batcher = createSpanBatcher(store, { max: 100, batchMax: 3, flushIntervalMs: 60_000 });
    batcher.start();
    batcher.start(); // 幂等:不叠加定时器
    const rows = Array.from({ length: 7 }, (_, i) => row('t', String(i)));
    batcher.push(rows);
    await drain(batcher);
    expect(store.batches.map((b) => b.length)).toEqual([3, 3, 1]);
    await batcher.close();
  });

  it('close 尽力排空;写入持续失败时放弃剩余不死循环', async () => {
    let failFirst = true;
    const store = fakeStore({
      write: () => {
        if (failFirst) {
          failFirst = false;
          return Promise.reject(new Error('once'));
        }
        return Promise.resolve(1);
      },
    });
    const batcher = createSpanBatcher(store, { max: 100, batchMax: 1, flushIntervalMs: 60_000 });
    batcher.push([row('t', '1'), row('t', '2')]);
    await drain(batcher); // push 已自动触发首批(失败被丢),排空触发第二批(成功)
    await batcher.close();
    expect(store.batches).toHaveLength(2);
    expect(batcher.getStats().queueDepth).toBe(0);

    const dead = fakeStore({ write: () => Promise.reject(new Error('always')) });
    const deadBatcher = createSpanBatcher(dead, { max: 100, batchMax: 2, flushIntervalMs: 60_000 });
    deadBatcher.push([row('t', '1'), row('t', '2')]);
    await deadBatcher.close(); // 持续失败:放弃,终止
    // push 自动触发的后台 flush 的 catch 在微任务里落账——等一拍再断言
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(deadBatcher.getStats().droppedWriteError).toBe(2);
    expect(deadBatcher.getStats().queueDepth).toBe(0);
  });

  it('空入队零副作用;lastFlushAt 在成功后更新', async () => {
    const store = fakeStore();
    const batcher = createSpanBatcher(store, { max: 10, batchMax: 10, flushIntervalMs: 60_000 });
    expect(batcher.push([])).toBe(0);
    await batcher.flush(); // 空队列 no-op
    expect(store.batches).toHaveLength(0);
    batcher.push([row('t', '1')]);
    await batcher.flush();
    expect(batcher.getStats().lastFlushAt).not.toBeNull();
  });
});
