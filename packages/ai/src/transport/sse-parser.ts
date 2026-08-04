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
  /** 捕获到首个错误帧时通知（relay 用它在透传的同时发 stream_error 事件） */
  onErrorFrame?: (frame: StreamError) => void;
}

export class SseScanner {
  private usage: unknown | null = null;
  private errorFrame: StreamError | null = null;
  private eventsCompleted = 0;
  private lastEventAt = 0;
  /** stream 模式：跨 chunk 的多字节 UTF-8 安全解码（feed 需 string） */
  private decoder = new TextDecoder('utf-8');

  /** 事件边界状态机（心跳注入判定）：最近结束的行是否为空行 */
  private lastLineEnded = false;
  private lastLineWasBlank = false;
  private lineHasContent = false;

  private parser = createParser({
    onEvent: (ev) => {
      // v3.1: EventSourceMessage = { data, event?, id? }，无 type 判别字段
      if (typeof ev.data !== 'string') return;
      this.eventsCompleted += 1;
      this.lastEventAt = Date.now();
      this.callbacks?.onEvent?.(ev.data, ev.event);
      const parsed = this.tryParse(ev.data);
      if (!parsed) return;
      if (parsed.usage !== undefined && parsed.usage !== null) {
        // 最后 usage 帧胜出；忽略 usage:null（部分供应商中间/尾帧带 null，避免覆盖真实 usage）
        this.usage = parsed.usage;
      }
      if (this.errorFrame === null && parsed.error !== undefined) {
        this.errorFrame = this.toErrorFrame(parsed.error);
        this.callbacks?.onErrorFrame?.(this.errorFrame);
      }
    },
  });

  constructor(private readonly callbacks?: SseScannerCallbacks) {}

  /** 喂入上游 chunk；返回本次完成的完整事件数（心跳边界判定用） */
  consume(chunk: Uint8Array): number {
    const before = this.eventsCompleted;
    const text = this.decoder.decode(chunk, { stream: true });
    try {
      this.parser.feed(text);
    } catch {
      // 解析容错：异常 chunk 不中断透传（扫描是旁路）
    }
    this.trackBoundary(text);
    return this.eventsCompleted - before;
  }

  /**
   * 当前是否位于 SSE 事件边界（可安全注入 ': keep-alive' 心跳帧）。
   * 边界 = 最近一个以 \n 结束的行是空行，且当前没有未完成行内容——
   * "data: a\n"（行结束但事件未完）不算边界，防止心跳拆开半截事件。
   */
  atBoundary(): boolean {
    return !this.lineHasContent && (!this.lastLineEnded || this.lastLineWasBlank);
  }

  /** 行级边界跟踪：只关心"空行是否已发生"，不缓存行内容（O(1) 内存） */
  private trackBoundary(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') {
        this.lastLineEnded = true;
        this.lastLineWasBlank = !this.lineHasContent;
        this.lineHasContent = false;
      } else if (ch !== '\r') {
        // \r 不改变状态：CRLF 的 \r 被忽略，\n 统一判定（SSE 规范只认 \n）
        this.lineHasContent = true;
      }
    }
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
    this.lastLineEnded = false;
    this.lastLineWasBlank = false;
    this.lineHasContent = false;
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
