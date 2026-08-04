import { createParser } from 'eventsource-parser';
import type { StreamError } from '../types.js';

/**
 * SSE 增量扫描器（eventsource-parser v3 薄封装）：
 * 事件边界 / 注释行 / 多行 data / usage 最后帧胜出 / 错误帧捕获
 *
 * 旁路架构：relay-stream 把上游 chunk 原样写入输出流（透传），
 * 同时 feed 给本扫描器（不消费流）——扫描结果用于计量与心跳边界判定。
 */

export interface SseScannerCallbacks {
  /** 每个完整事件触发（data 为多行 data 拼接后的原文，event 为事件名） */
  onEvent?: (data: string, event: string | undefined) => void;
}

export class SseScanner {
  private usage: unknown | null = null;
  private errorFrame: StreamError | null = null;
  private eventsCompleted = 0;
  private lastEventAt = 0;
  /** stream 模式：跨 chunk 的多字节 UTF-8 安全解码（feed 需 string） */
  private decoder = new TextDecoder('utf-8');

  private parser = createParser({
    onEvent: (ev) => {
      // v3.1: EventSourceMessage = { data, event?, id? }，无 type 判别字段
      if (typeof ev.data !== 'string') return;
      this.eventsCompleted += 1;
      this.lastEventAt = Date.now();
      this.callbacks?.onEvent?.(ev.data, ev.event);
      const parsed = this.tryParse(ev.data);
      if (!parsed) return;
      if (parsed.usage !== undefined) {
        this.usage = parsed.usage; // 最后 usage 帧胜出
      }
      if (this.errorFrame === null && parsed.error !== undefined) {
        this.errorFrame = this.toErrorFrame(parsed.error);
      }
    },
  });

  constructor(private readonly callbacks?: SseScannerCallbacks) {}

  /** 喂入上游 chunk；返回本次完成的完整事件数（心跳边界判定用） */
  consume(chunk: Uint8Array): number {
    const before = this.eventsCompleted;
    try {
      this.parser.feed(this.decoder.decode(chunk, { stream: true }));
    } catch {
      // 解析容错：异常 chunk 不中断透传（扫描是旁路）
    }
    return this.eventsCompleted - before;
  }

  /** 最后 usage 帧（解析后的原始 usage 对象，null = 流中无 usage） */
  getUsage(): unknown | null {
    return this.usage;
  }

  /** 首个错误帧（流式错误），null = 无 */
  getErrorFrame(): StreamError | null {
    return this.errorFrame;
  }

  /** 最近一次完整事件的时间戳（心跳判定） */
  getLastEventAt(): number {
    return this.lastEventAt;
  }

  reset(): void {
    this.usage = null;
    this.errorFrame = null;
    this.eventsCompleted = 0;
    this.lastEventAt = 0;
    this.parser.reset();
  }

  private tryParse(data: string): Record<string, unknown> | null {
    try {
      const v = JSON.parse(data);
      return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private toErrorFrame(error: unknown): StreamError {
    const e = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
    return {
      code:
        typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : 'stream_error',
      type: typeof e.type === 'string' ? e.type : undefined,
      detail: typeof e.message === 'string' ? e.message : undefined,
    };
  }
}
