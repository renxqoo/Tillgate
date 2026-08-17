import type { StreamError } from '../types';

/**
 * SSE 字节流 ⇄ 事件 的共享转换骨架（codec 层共用，单一实现）。
 *
 * 行缓冲 + UTF-8 跨 chunk 安全解码；事件按空行边界聚合（data: 多行拼接），
 * 与 eventsource-parser 同语义但保留 event: 行名（claude 事件流需要）。
 */

export interface SseEvent {
  event?: string;
  data: string;
}

export function createSseEventReader(onEvent: (ev: SseEvent) => void): {
  push(chunk: Uint8Array): void;
  flush(): void;
} {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
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
    if (l.startsWith(':')) return; // 注释
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
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        line(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      }
    },
    flush() {
      buffer += decoder.decode();
      if (buffer.length > 0) line(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
      dispatch();
    },
  };
}

/** 规范形 OpenAI 帧序列化（chunk / usage / [DONE] / 错误帧共用出口） */
export function openaiFrame(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

export function openaiDone(): Uint8Array {
  return new TextEncoder().encode('data: [DONE]\n\n');
}

export function openaiErrorFrame(frame: StreamError): Uint8Array {
  return openaiFrame({ error: { code: frame.code, type: frame.type, message: frame.detail } });
}

/**
 * 通用 SSE→SSE 转换管道：按事件读入 → 转换器逐事件产出（0..n 帧字节）→ 写出。
 * 转换器同步 emit（一个上游事件 → 多个规范帧，如 claude message_start →
 * role 帧；flush 支持流末补帧）。行缓冲跨 chunk 持久（半截事件不丢）。
 */
export function sseToSseStream(
  upstream: ReadableStream<Uint8Array>,
  convertEvent: (ev: SseEvent, emit: (bytes: Uint8Array) => void) => void,
  convertFlush?: (emit: (bytes: Uint8Array) => void) => void,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const pending: Uint8Array[] = [];
  const eventReader = createSseEventReader((ev) => {
    convertEvent(ev, (bytes) => pending.push(bytes));
  });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (pending.length > 0) {
          // 逐字节组产出（pull 语义：一次 enqueue 一组即可，这里全放行——下游按块读）
          for (const bytes of pending.splice(0)) controller.enqueue(bytes);
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          eventReader.flush();
          convertFlush?.((bytes) => controller.enqueue(bytes));
          controller.close();
          return;
        }
        eventReader.push(value!);
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
}

export type { StreamError };
