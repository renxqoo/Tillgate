import { SseScanner } from './sse-parser.js';
import type { StreamError } from '../types.js';

/**
 * 透传管道（ai-package.md §7.4）：
 *   - 上游 chunk 逐块透传（pipeThrough，不缓冲），旁路 SseScanner 扫描 usage/错误帧
 *   - 心跳注入：静默 > heartbeatIdleMs 发 ': keep-alive'
 *   - 静默超时：上游 > inactivityTimeoutMs 无数据 → 注入错误帧 + terminate
 *   - 客户端 abort → cancel 上游（pipeThrough 自动传播）
 *   - 上游读失败 → pipeTo 的 catch 触发 upstream_disconnected
 *
 * 关键：用 TransformStream + pipeThrough（而非 new ReadableStream({ pull })）。
 *   pull 模式的 controller 队列在 node-server 下会被一次性读出（缓冲）。
 *   pipeThrough 的数据流是 push-through：上游 push → transform → 下游 push，逐块流过。
 */

const enc = (s: string) => new TextEncoder().encode(s);

export interface RelayStreamOptions {
  heartbeatIdleMs: number;
  inactivityTimeoutMs: number;
  checkIntervalMs?: number;
}

export type RelayStreamEvent =
  | { type: 'stream_error'; frame: StreamError }
  | { type: 'aborted'; reason: 'client_disconnect' | 'inactivity' | 'upstream_disconnected' }
  | {
      type: 'done';
      usage: unknown | null;
      errorFrame: StreamError | null;
      bytesRelayed: number;
      terminated?: 'client_disconnect' | 'inactivity' | 'upstream_disconnected';
    };

export interface RelayStreamHandle {
  stream: ReadableStream<Uint8Array>;
  onEvent: (cb: (e: RelayStreamEvent) => void) => void;
}

export function relayStream(
  upstream: ReadableStream<Uint8Array>,
  options: RelayStreamOptions,
): RelayStreamHandle {
  const { heartbeatIdleMs, inactivityTimeoutMs } = options;
  const checkIntervalMs = options.checkIntervalMs ?? Math.min(250, Math.max(10, heartbeatIdleMs / 2));
  const listeners: Array<(e: RelayStreamEvent) => void> = [];
  const emit = (e: RelayStreamEvent): void => {
    for (const l of listeners) {
      try {
        l(e);
      } catch {
        /* noop */
      }
    }
  };

  const scanner = new SseScanner({
    onErrorFrame: (frame) => emit({ type: 'stream_error', frame }),
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let finished = false;
  let lastDataAt = 0;
  let lastWriteAt = 0;
  let bytesRelayed = 0;
  // 控制器引用（transform.start 里赋值），供定时器/错误帧注入用
  let tCtrl: TransformStreamDefaultController<Uint8Array> | null = null;

  const finishOk = (): void => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearInterval(timer);
    emit({
      type: 'done',
      usage: scanner.getUsage(),
      errorFrame: scanner.getErrorFrame(),
      bytesRelayed,
      terminated: undefined,
    });
  };

  const failWithErrorFrame = (
    frame: StreamError,
    reason: 'inactivity' | 'upstream_disconnected',
  ): void => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearInterval(timer);
    emit({ type: 'aborted', reason });
    if (tCtrl) {
      try {
        tCtrl.enqueue(
          enc(`data: ${JSON.stringify({ error: { code: frame.code, type: frame.type, message: frame.detail } })}\n\n`),
        );
      } catch {
        /* 已关闭 */
      }
    }
    emit({
      type: 'done',
      usage: scanner.getUsage(),
      errorFrame: frame,
      bytesRelayed,
      terminated: reason,
    });
    if (tCtrl) {
      try {
        tCtrl.terminate();
      } catch {
        /* 已终止 */
      }
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(ctrl) {
      tCtrl = ctrl;
      timer = setInterval(() => {
        if (finished) return;
        const now = Date.now();
        if (lastDataAt > 0 && now - lastDataAt >= inactivityTimeoutMs) {
          failWithErrorFrame(
            { code: 'stream_inactivity_timeout', detail: `no upstream data for ${inactivityTimeoutMs}ms` },
            'inactivity',
          );
          return;
        }
        if (lastDataAt > 0 && scanner.atBoundary() && now - lastWriteAt >= heartbeatIdleMs) {
          try {
            ctrl.enqueue(enc(': keep-alive\n\n'));
            lastWriteAt = now;
          } catch {
            /* 已关闭 */
          }
        }
      }, checkIntervalMs);
    },
    transform(chunk, ctrl) {
      if (finished) return;
      lastDataAt = Date.now();
      scanner.consume(chunk);
      ctrl.enqueue(chunk);
      bytesRelayed += chunk.byteLength;
      lastWriteAt = Date.now();
    },
    flush() {
      // 上游正常 EOF → flush 触发（pipeThrough 自动关闭 writable → flush）
      finishOk();
    },
    cancel() {
      // 客户端断开（readable 端被 cancel）
      if (!finished) {
        finished = true;
        if (timer !== null) clearInterval(timer);
        emit({ type: 'aborted', reason: 'client_disconnect' });
        emit({
          type: 'done',
          usage: scanner.getUsage(),
          errorFrame: scanner.getErrorFrame(),
          bytesRelayed,
          terminated: 'client_disconnect',
        });
      }
    },
  });

  // pipeTo：上游 → transform.writable
  // preventAbort: 上游错误时不自动 abort writable（让我们手动注入错误帧后再关闭）
  // preventCancel: 不自动 cancel 上游（已在 cancel 回调里处理客户端断开）
  const pipePromise = upstream.pipeTo(transform.writable, {
    preventAbort: true,
    preventCancel: false,
  }).catch(async () => {
    // 上游读取错误 → 注入错误帧（通过 controller，pipeTo 已结束但 writable 未 abort）
    if (!finished && tCtrl) {
      try {
        tCtrl.enqueue(
          enc(`data: ${JSON.stringify({ error: { code: 'upstream_disconnected', message: 'upstream read error' } })}\n\n`),
        );
        tCtrl.terminate();
      } catch {
        /* 已关闭 */
      }
      finished = true;
      if (timer !== null) clearInterval(timer);
      emit({ type: 'aborted', reason: 'upstream_disconnected' });
      emit({
        type: 'done',
        usage: scanner.getUsage(),
        errorFrame: { code: 'upstream_disconnected', detail: 'upstream read error' },
        bytesRelayed,
        terminated: 'upstream_disconnected',
      });
    }
  });
  void pipePromise;

  const stream = transform.readable;

  return {
    stream,
    onEvent: (cb) => {
      listeners.push(cb);
    },
  };
}
