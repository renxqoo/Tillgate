import { SseScanner } from './sse-parser';
import type { StreamError } from '../types';
import { asServerDrainAbort } from '../errors/server-drain';

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
  signal?: AbortSignal;
}

export type RelayStreamEvent =
  | { type: 'first_chunk' }
  | { type: 'stream_error'; frame: StreamError }
  | {
      type: 'aborted';
      reason:
        | 'client_disconnect'
        | 'request_cancelled'
        | 'server_draining'
        | 'inactivity'
        | 'upstream_error'
        | 'upstream_disconnected'
        | 'upstream_truncated';
    }
  | {
      type: 'done';
      usage: unknown | null;
      errorFrame: StreamError | null;
      bytesRelayed: number;
      terminated?:
        | 'client_disconnect'
        | 'request_cancelled'
        | 'server_draining'
        | 'inactivity'
        | 'upstream_error'
        | 'upstream_disconnected'
        | 'upstream_truncated';
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
  const checkIntervalMs =
    options.checkIntervalMs ?? Math.min(250, Math.max(10, heartbeatIdleMs / 2));
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

  const finishOk = (normalizedMissingDone = false): void => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearInterval(timer);
    const errorFrame = scanner.getErrorFrame();
    if (errorFrame && !normalizedMissingDone) emit({ type: 'aborted', reason: 'upstream_error' });
    emit({
      type: 'done',
      usage: scanner.getUsage(),
      errorFrame,
      bytesRelayed,
      terminated: errorFrame && !normalizedMissingDone ? 'upstream_error' : undefined,
    });
  };

  const failWithErrorFrame = (
    frame: StreamError,
    reason:
      | 'request_cancelled'
      | 'server_draining'
      | 'inactivity'
      | 'upstream_disconnected'
      | 'upstream_truncated',
    controller: TransformStreamDefaultController<Uint8Array> | null = tCtrl,
    terminate = true,
  ): void => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearInterval(timer);
    emit({ type: 'stream_error', frame });
    emit({ type: 'aborted', reason });
    if (controller) {
      try {
        controller.enqueue(
          enc(
            `data: ${JSON.stringify({ error: { code: frame.code, type: frame.type, message: frame.detail } })}\n\n`,
          ),
        );
        controller.enqueue(enc('data: [DONE]\n\n'));
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
    if (terminate && controller) {
      try {
        controller.terminate();
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
            {
              code: 'stream_inactivity_timeout',
              detail: `no upstream data for ${inactivityTimeoutMs}ms`,
            },
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
      // 首个数据 chunk 流经（上游首字节 → 客户端）：一次性事件，网关据此记真实 TTFB
      // （订阅晚于流开始的消费方拿不到「尝试开始」，只能从这里锚定首字节时刻）
      if (bytesRelayed === 0) emit({ type: 'first_chunk' });
      lastDataAt = Date.now();
      scanner.consume(chunk);
      ctrl.enqueue(chunk);
      bytesRelayed += chunk.byteLength;
      lastWriteAt = Date.now();
    },
    flush(ctrl) {
      // `[DONE]` 是成功的权威边界。只有 finish_reason 到达但尾哨兵缺失时可安全补齐；
      // 既无终止帧又无哨兵的 clean EOF 仍是截断，不能伪装成成功。
      if (scanner.hasDone()) {
        finishOk();
      } else if (scanner.hasTerminalFrame() && !scanner.getErrorFrame()) {
        ctrl.enqueue(enc('data: [DONE]\n\n'));
        finishOk(true);
      } else if (scanner.getErrorFrame()) {
        ctrl.enqueue(enc('data: [DONE]\n\n'));
        finishOk();
      } else {
        failWithErrorFrame(
          {
            code: 'upstream_stream_truncated',
            detail: 'upstream stream ended before a terminal event',
          },
          'upstream_truncated',
          ctrl,
          false,
        );
      }
    },
    cancel() {
      // 客户端断开（readable 端被 cancel）。#6649 同类：客户端在 [DONE]/终止帧
      // 之后立刻关闭连接是 HTTP/1.1 流式客户端的标准行为——已正常完成的流
      // 不得归类为 client_disconnect（否则 usage_logs.stream_aborted 被打标、
      // 无 usage 的流误走估算结算）。完成语义与 flush() 同优先级：
      // [DONE] > 终止帧（无错误帧）> 错误帧（upstream_error）> 真正的用户中断。
      if (!finished) {
        finished = true;
        if (timer !== null) clearInterval(timer);
        const errorFrame = scanner.getErrorFrame();
        const completed = scanner.hasDone() || (scanner.hasTerminalFrame() && !errorFrame);
        if (!completed) {
          emit({ type: 'aborted', reason: 'client_disconnect' });
          emit({
            type: 'done',
            usage: scanner.getUsage(),
            errorFrame,
            bytesRelayed,
            terminated: 'client_disconnect',
          });
        } else {
          if (errorFrame) emit({ type: 'aborted', reason: 'upstream_error' });
          emit({
            type: 'done',
            usage: scanner.getUsage(),
            errorFrame,
            bytesRelayed,
            terminated: errorFrame ? 'upstream_error' : undefined,
          });
        }
      }
    },
  });

  // pipeTo：上游 → transform.writable
  // preventAbort: 上游错误时不自动 abort writable（让我们手动注入错误帧后再关闭）
  // preventCancel: 不自动 cancel 上游（已在 cancel 回调里处理客户端断开）
  const pipePromise = upstream
    .pipeTo(transform.writable, {
      preventAbort: true,
      preventCancel: false,
      signal: options.signal,
    })
    .catch(async () => {
      // 上游读取错误 → 注入错误帧（通过 controller，pipeTo 已结束但 writable 未 abort）
      if (!finished && tCtrl) {
        // 服务端 drain 中止（宽限期后的 ServerDrainAbort 标记）是服务端责任：
        // 归类 server_draining（计费侧全额释放），不得混入用户取消（估算结算）
        const drain = options.signal ? asServerDrainAbort(options.signal.reason) : null;
        const reason = drain
          ? 'server_draining'
          : options.signal?.aborted
            ? 'request_cancelled'
            : 'upstream_disconnected';
        const frame = drain
          ? { code: 'server_draining', detail: 'gateway draining' }
          : options.signal?.aborted
            ? { code: 'request_cancelled', detail: 'request cancelled while reading upstream' }
            : { code: 'upstream_disconnected', detail: 'upstream read error' };
        failWithErrorFrame(frame, reason);
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
