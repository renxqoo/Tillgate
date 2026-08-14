import type { SpanRow, TraceStore } from '@ai-gateway/tracing';

/**
 * span 批量写入器：有界队列 + 定时/定量 flush。
 *
 * 数据等级（诊断数据 best-effort）：
 *   - 队列满 → 丢最旧并计数；
 *   - 写入失败 → 本批丢弃并计数（记 lastError），绝不重试阻塞、绝不抛回调用方；
 *   - 观测链路的任何故障都不允许反压业务请求路径。
 */
export interface BatcherOptions {
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

export class SpanBatcher {
  private queue: SpanRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly stats: BatcherStats = {
    received: 0,
    queued: 0,
    flushed: 0,
    droppedOverflow: 0,
    droppedWriteError: 0,
    lastError: null,
    lastFlushAt: null,
  };

  constructor(
    private readonly store: TraceStore,
    private readonly options: BatcherOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    this.timer.unref?.();
  }

  /** 入队：满则丢最旧。返回本次因溢出丢弃的数量（调用方把它并入响应/计数）。 */
  push(rows: SpanRow[]): number {
    if (rows.length === 0) return 0;
    this.stats.received += rows.length;
    let dropped = 0;
    for (const row of rows) {
      this.queue.push(row);
      if (this.queue.length > this.options.max) {
        this.queue.shift();
        dropped += 1;
        this.stats.droppedOverflow += 1;
      }
    }
    if (this.queue.length >= this.options.batchMax) void this.flush();
    return dropped;
  }

  /** 立即刷写（定时器/定量/关闭共用）。失败丢弃整批并计数，不抛出。 */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.options.batchMax);
    try {
      await this.store.writeBatch(batch);
      this.stats.flushed += batch.length;
      this.stats.lastFlushAt = Date.now();
      this.stats.lastError = null;
    } catch (error) {
      // best-effort：诊断数据写不进去就丢，绝不让观测故障影响接收端存活
      this.stats.droppedWriteError += batch.length;
      this.stats.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.flushing = false;
    }
    if (this.queue.length >= this.options.batchMax) void this.flush();
  }

  getStats(): BatcherStats & { queueDepth: number } {
    return { ...this.stats, queueDepth: this.queue.length };
  }

  /** 优雅停机：尽力刷完剩余 */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.queue.length > 0) {
      const before = this.queue.length;
      await this.flush();
      if (this.queue.length === before) break; // 写入持续失败：放弃剩余
    }
  }
}
