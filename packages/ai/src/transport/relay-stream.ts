import type { Transformer } from 'node:stream/web';
import { SseScanner } from './sse-parser';
import { registerSweep } from './heartbeat';
import { SseModelRewriter } from './model-rewrite';
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
  /**
   * 响应侧 model 字段替换（§3.6 透传例外 2）：给出即开启——出站 SSE 帧内仅替换
   * "model" 字符串值为该值（对外目录模型名），其余字节不动；undefined = 关闭，
   * 逐字节透传。逐事件行改写（不整流缓冲），覆盖同协议中继与跨协议转换出站两条路径。
   */
  rewriteModel?: string;
  checkIntervalMs?: number;
  signal?: AbortSignal;
}

export type RelayStreamEvent =
  | { type: 'first_chunk'; atMs: number }
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
      /** 扫描器累计的输出内容文本（usage 缺失/取消时的输出估算源） */
      outputFeatures?: import('../types').TextTokenFeatures;
      /** 终止细节（观测/计费留痕）：[DONE] 哨兵是否到达；终止帧（finish_reason）是否到达 */
      doneSentinel?: boolean;
      terminalFrame?: boolean;
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
  const listeners: Array<(e: RelayStreamEvent) => void> = [];
  const emit = (e: RelayStreamEvent): void => {
    for (const l of listeners.slice()) {
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

  // model 改写器（例外 2）：数据面内联改写——行状态机有界缓冲，逐事件吐出
  const rewriter =
    options.rewriteModel !== undefined ? new SseModelRewriter(options.rewriteModel) : null;

  let unregisterSweep: (() => void) | null = null;
  let finished = false;
  let lastDataAt = 0;
  let lastWriteAt = 0;
  let bytesRelayed = 0;
  // 控制器引用（transform.start 里赋值），供定时器/错误帧注入用
  let tCtrl: TransformStreamDefaultController<Uint8Array> | null = null;

  const finishOk = (normalizedMissingDone = false): void => {
    if (finished) return;
    finished = true;
    if (unregisterSweep !== null) unregisterSweep();
    const errorFrame = scanner.getErrorFrame();
    if (errorFrame && !normalizedMissingDone) emit({ type: 'aborted', reason: 'upstream_error' });
    emit({
      type: 'done',
      usage: scanner.getUsage(),
      errorFrame,
      bytesRelayed,
      outputFeatures: scanner.getFeatures().snapshot(),
      doneSentinel: normalizedMissingDone ? false : scanner.hasDone(),
      terminalFrame: scanner.hasTerminalFrame(),
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
    if (unregisterSweep !== null) {
      unregisterSweep();
      unregisterSweep = null;
    }
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
      outputFeatures: scanner.getFeatures().snapshot(),
      doneSentinel: scanner.hasDone(),
      terminalFrame: scanner.hasTerminalFrame(),
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

  const transformer: Transformer<Uint8Array, Uint8Array> = {
    start(ctrl) {
      tCtrl = ctrl;
      unregisterSweep = registerSweep(() => {
        if (finished) return false;
        const now = Date.now();
        if (lastDataAt > 0 && now - lastDataAt >= inactivityTimeoutMs) {
          failWithErrorFrame(
            {
              code: 'stream_inactivity_timeout',
              detail: `no upstream data for ${inactivityTimeoutMs}ms`,
            },
            'inactivity',
          );
          return true;
        }
        if (lastDataAt > 0 && scanner.atBoundary() && now - lastWriteAt >= heartbeatIdleMs) {
          try {
            ctrl.enqueue(enc(': keep-alive\n\n'));
            lastWriteAt = now;
          } catch {
            /* 已关闭 */
          }
        }
        return true;
      });
    },
    transform(chunk, ctrl) {
      if (finished) return;
      // 首个数据 chunk 流经（上游首字节 → 客户端）：一次性事件，网关据此记真实 TTFB
      // （订阅晚于流开始的消费方拿不到「尝试开始」，只能从这里锚定首字节时刻）
      lastDataAt = Date.now();
      // 例外 2：出站 model 替换（改写后的字节才是 C 端与扫描器所见；无改写则原 chunk）
      const out = rewriter !== null ? rewriter.push(chunk) : chunk;
      if (out.byteLength > 0) {
        if (bytesRelayed === 0) emit({ type: 'first_chunk', atMs: Date.now() });
        scanner.consume(out);
        ctrl.enqueue(out);
        bytesRelayed += out.byteLength;
        lastWriteAt = Date.now();
      }
      // 半截行被改写器持有（有界）：不推进 first_chunk/bytesRelayed，下一 chunk 补齐后吐出
    },
    flush(ctrl) {
      // 改写器尾行先吐（此后才轮到 [DONE] 兜底注入，保持帧序）
      if (rewriter !== null) {
        const tail = rewriter.flush();
        if (tail.byteLength > 0) {
          scanner.consume(tail);
          ctrl.enqueue(tail);
          bytesRelayed += tail.byteLength;
        }
      }
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
        if (unregisterSweep !== null) {
          unregisterSweep();
          unregisterSweep = null;
        }
        const errorFrame = scanner.getErrorFrame();
        const completed = scanner.hasDone() || (scanner.hasTerminalFrame() && !errorFrame);
        if (!completed) {
          emit({ type: 'aborted', reason: 'client_disconnect' });
          emit({
            type: 'done',
            usage: scanner.getUsage(),
            errorFrame,
            bytesRelayed,
            outputFeatures: scanner.getFeatures().snapshot(),
            doneSentinel: scanner.hasDone(),
            terminalFrame: scanner.hasTerminalFrame(),
            terminated: 'client_disconnect',
          });
        } else {
          if (errorFrame) emit({ type: 'aborted', reason: 'upstream_error' });
          emit({
            type: 'done',
            usage: scanner.getUsage(),
            errorFrame,
            bytesRelayed,
            outputFeatures: scanner.getFeatures().snapshot(),
            doneSentinel: scanner.hasDone(),
            terminalFrame: scanner.hasTerminalFrame(),
            terminated: errorFrame ? 'upstream_error' : undefined,
          });
        }
      }
    },
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>(transformer);

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
        // 归类 server_draining——部分交付即计费（2026-08-21 拍板：估算结算，
        // 归属 server_draining 分标签，报表可查、可接运营补偿），不得混入用户取消
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
