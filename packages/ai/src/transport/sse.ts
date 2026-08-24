import type { StreamError } from '../types';

/**
 * 统一 SSE 解析原语（修 v1 双实现 S3/S4）：
 *   - 单一行缓冲 + UTF-8 跨 chunk 流式解码 + 事件聚合（保留 event: 行名——claude 事件流需要）；
 *   - 流转换统一走 TransformStream + pipeThrough（v1 relay 的 node-server 缓冲教训，
 *     不用 new ReadableStream({ pull }) 模式）；
 *   - 边界跟踪（心跳注入判定）与帧序列化共用本模块。
 * scanner（旁路扫描）与 protocol codec（流转换）都基于此，不再各自实现。
 */

export interface SseEvent {
  event?: string;
  data: string;
}

/** 单行最大字节数默认值（内存上界：无换行的故障/恶意流不得撑爆行缓冲；1MiB） */
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

export interface SseEventReaderOptions {
  /** 单行（含换行符）最大字节数，默认 1MiB；超限抛英文错误并清空缓冲（流终止） */
  maxLineBytes?: number;
}

const lineEncoder = new TextEncoder();

// eslint-disable-next-line max-lines-per-function -- SSE 解析原语：行缓冲/记账/派发共享闭包状态的一体实现（scanner 与 codec 共用），存量棘轮（铁律 22⑥）
export function createSseEventReader(
  onEvent: (ev: SseEvent) => void,
  opts: SseEventReaderOptions = {},
): {
  push(chunk: Uint8Array): void;
  flush(): void;
} {
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let bufferBytes = 0; // 未消费字节数（含 decoder 内未落串的多字节残段）——增量记账，O(n) 摊销
  let pendingEvent: string | undefined;
  let dataLines: string[] = [];

  function dispatch(): void {
    if (dataLines.length === 0) {
      pendingEvent = undefined;
      return;
    }
    onEvent({ event: pendingEvent, data: dataLines.join('\n') });
    pendingEvent = undefined;
    dataLines = [];
  }

  function line(l: string): void {
    if (l === '') {
      dispatch();
      return;
    }
    if (l.startsWith(':')) return; // 注释行
    if (l.startsWith('data:')) {
      dataLines.push(l.slice(5).replace(/^ /, ''));
      return;
    }
    if (l.startsWith('event:')) {
      pendingEvent = l.slice(6).replace(/^ /, '');
      return;
    }
    // id:/retry: 等其余字段忽略
  }

  return {
    push(chunk) {
      bufferBytes += chunk.byteLength;
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        bufferBytes -= lineEncoder.encode(raw).length + 1; // 已消费行出账（+1 = 换行符）
        line(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      }
      // 剩余 buffer 是无换行的半截行：超上界即抛（内存上界；缓冲清空防反复重放）
      if (bufferBytes > maxLineBytes) {
        buffer = '';
        bufferBytes = 0;
        throw new Error(`SSE line exceeds maximum of ${maxLineBytes} bytes`);
      }
    },
    flush() {
      buffer += decoder.decode();
      if (buffer.length > 0) line(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
      dispatch();
    },
  };
}

/**
 * 事件边界跟踪（心跳注入判定，O(1) 内存——只跟踪「空行是否已发生」，不缓存行内容）：
 * 边界 = 无未完成行内容，且（从未有行结束 | 最近结束的行是空行）。
 * "data: a\n"（行结束但事件未完）不算边界——防心跳拆开半截事件。
 */
export class SseBoundaryTracker {
  private everLineEnded = false;
  private lastLineWasBlank = false;
  private lineHasContent = false;

  track(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') {
        this.everLineEnded = true;
        this.lastLineWasBlank = !this.lineHasContent;
        this.lineHasContent = false;
      } else if (ch !== '\r') {
        // \r 不改变状态：CRLF 的 \r 忽略，\n 统一判定（SSE 规范只认 \n）
        this.lineHasContent = true;
      }
    }
  }

  atBoundary(): boolean {
    return !this.lineHasContent && (!this.everLineEnded || this.lastLineWasBlank);
  }
}

// ---- 规范形帧序列化（created 时间戳由 codec 每流缓存一次写入 obj——修 v1 每帧重算 D9）----

export function openaiFrame(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

export function openaiDone(): Uint8Array {
  return new TextEncoder().encode('data: [DONE]\n\n');
}

export function openaiErrorFrame(frame: StreamError): Uint8Array {
  return new TextEncoder().encode(
    `data: ${JSON.stringify({ error: { code: frame.code, type: frame.type, message: frame.detail } })}\n\n`,
  );
}

/**
 * 通用 SSE→SSE 转换管道：按事件读入 → 转换器逐事件产出（0..n 帧字节）→ 写出。
 * 转换器同步 emit（一个上游事件 → 多个规范帧）；convertFlush 支持流末补帧。
 * TransformStream 形态：背压由平台传导（pipeThrough），取消向上游传播。
 */
export function sseToSseStream(
  upstream: ReadableStream<Uint8Array>,
  convertEvent: (ev: SseEvent, emit: (bytes: Uint8Array) => void) => void,
  convertFlush?: (emit: (bytes: Uint8Array) => void) => void,
): ReadableStream<Uint8Array> {
  const pending: Uint8Array[] = [];
  const reader = createSseEventReader((ev) => {
    convertEvent(ev, (bytes) => pending.push(bytes));
  });

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      reader.push(chunk);
      for (const bytes of pending.splice(0)) controller.enqueue(bytes);
    },
    flush(controller) {
      reader.flush();
      convertFlush?.((bytes) => controller.enqueue(bytes));
    },
  });

  return upstream.pipeThrough(transform);
}
