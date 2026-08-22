import type { SpanRow, TraceStore } from './types';

/**
 * span 批量写入器(接收端摄入):有界队列 + 定时/定量 flush。
 *
 * 数据等级(诊断数据 best-effort):
 *   - 队列满 → 丢最旧并计数;
 *   - 写入失败 → 本批丢弃并计数(记 lastError),绝不重试阻塞、绝不抛回调用方;
 *   - 观测链路的任何故障都不允许反压业务请求路径。
 *
 * v1 SpanBatcher class 的工厂闭包重写(G5);溢出 shift() 的 O(n) 口径见 IMPLEMENTATION B6。
 */

export interface SpanBatcherOptions {
  max: number;
  batchMax: number;
  flushIntervalMs: number;
}

export interface BatcherStats {
  received: number;
  queued: number;
  flushed: number;
  droppedOverflow: number;
  droppedWriteError: number;
  lastError: string | null;
  lastFlushAt: number | null;
}

export interface SpanBatcher {
  start(): void;
  /** 入队:满则丢最旧。返回本次因溢出丢弃的数量(调用方把它并入响应/计数) */
  push(rows: SpanRow[]): number;
  /** 立即刷写(定时器/定量/关闭共用)。失败丢弃整批并计数,不抛出 */
  flush(): Promise<void>;
  getStats(): BatcherStats & { queueDepth: number };
  /** 优雅停机:尽力刷完剩余 */
  close(): Promise<void>;
}

export function createSpanBatcher(store: TraceStore, options: SpanBatcherOptions): SpanBatcher {
  let queue: SpanRow[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let flushing = false;
  const stats: BatcherStats = {
    received: 0,
    queued: 0,
    flushed: 0,
    droppedOverflow: 0,
    droppedWriteError: 0,
    lastError: null,
    lastFlushAt: null,
  };

  async function flush(): Promise<void> {
    if (flushing || queue.length === 0) return;
    flushing = true;
    const batch = queue.splice(0, options.batchMax);
    try {
      await store.writeBatch(batch);
      stats.flushed += batch.length;
      stats.lastFlushAt = Date.now();
      stats.lastError = null;
    } catch (error) {
      // best-effort:诊断数据写不进去就丢,绝不让观测故障影响接收端存活
      stats.droppedWriteError += batch.length;
      stats.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      flushing = false;
    }
    if (queue.length >= options.batchMax) await flush();
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void flush(), options.flushIntervalMs);
      timer.unref?.();
    },

    push(rows) {
      if (rows.length === 0) return 0;
      stats.received += rows.length;
      let dropped = 0;
      for (const row of rows) {
        queue.push(row);
        if (queue.length > options.max) {
          queue.shift();
          dropped += 1;
          stats.droppedOverflow += 1;
        }
      }
      if (queue.length >= options.batchMax) void flush();
      return dropped;
    },

    flush,

    getStats() {
      return { ...stats, queueDepth: queue.length };
    },

    async close() {
      if (timer) clearInterval(timer);
      timer = null;
      while (queue.length > 0) {
        const before = queue.length;
        await flush();
        if (queue.length === before) break; // 写入持续失败:放弃剩余
      }
    },
  };
}
