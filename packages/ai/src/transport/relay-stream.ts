import { SseScanner } from './sse-parser.js';
import type { StreamError } from '../types.js';

/**
 * 透传管道（ai-package.md §7.4）：
 *   - 上游 chunk 原样写入输出流（透传），旁路 SseScanner 扫描（usage / 错误帧 / 事件边界）
 *   - 心跳注入：静默 > heartbeatIdleMs 发 ': keep-alive'，仅 SSE 事件边界（防拆开半截事件）
 *   - 静默超时：上游 > inactivityTimeoutMs 无数据 → 断上游 + 注入 stream_inactivity_timeout 错误帧
 *   - 客户端 abort（输出流被取消）→ cancel 上游 reader（停止生成、停止计费）
 *   - 上游读失败 → 注入 upstream_disconnected 错误帧
 *   - 流内错误帧：原样透传（OpenAI 兼容格式），同时发 stream_error 事件
 * 背压：pull 驱动读循环，同一时刻只挂一个 read（nextRead），与心跳定时器竞争。
 */

const enc = (s: string) => new TextEncoder().encode(s);

export interface RelayStreamOptions {
  /** 静默超过该时长（输出无写入）注入心跳帧 */
  heartbeatIdleMs: number;
  /** 上游静默超过该时长判定死流：断上游 + 注入超时错误帧 */
  inactivityTimeoutMs: number;
  /**
   * 心跳/静默检查的定时器间隔（ms）。
   * 默认派生：min(250, max(10, heartbeatIdleMs/2))——inactivity 判定误差 ≤ 该值。
   * 调小提升响应速度（更早发现死流），调大降 CPU 开销（长流场景）。
   */
  checkIntervalMs?: number;
}

export type RelayStreamEvent =
  /** 流内错误帧（上游 SSE 透传的同时通知） */
  | { type: 'stream_error'; frame: StreamError }
  /** 异常终止原因（上游读失败也视为 disconnected） */
  | { type: 'aborted'; reason: 'client_disconnect' | 'inactivity' | 'upstream_disconnected' }
  /**
   * 流结束（正常 EOF / 异常），携带最终计量、错误帧、已透字节量与终止语义，总是最后发出。
   *   - terminated = undefined：正常结束（上游 EOF）
   *   - terminated = 中断原因：异常终止（inactivity / upstream_disconnected / client_disconnect）
   *   - bytesRelayed：累计透传给客户端的字节数（usage 缺失时 gateway 据此估算 tokens，5.11）
   */
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
    // 观察者异常不破坏透传管道
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
  const reader = upstream.getReader();

  let nextRead: ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pulling = false;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let lastDataAt = 0; // 上游数据最后到达时间（inactivity 判定）
  let lastWriteAt = 0; // 输出流最后写入时间（心跳判定）
  let bytesRelayed = 0; // 累计透传给客户端的字节数（5.11 估算依据）

  const tryEnqueue = (chunk: Uint8Array): void => {
    // 不检查 finished：failWithErrorFrame 先置 finished 再注入错误帧（与 tryClose 同理）
    if (!controller) return;
    try {
      controller.enqueue(chunk);
      bytesRelayed += chunk.byteLength; // 已透字节量（不含心跳帧：心跳是网关生成的，非上游内容）
      lastWriteAt = Date.now();
    } catch {
      // 流已取消（cancel 竞态）
    }
  };

  const tryClose = (): void => {
    // 注意：不能检查 finished——finishOk/failWithErrorFrame 先置 finished 再调本函数
    if (!controller) return;
    try {
      controller.close();
    } catch {
      /* 已关闭 */
    }
  };

  const clearTimer = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  /** 异常终止：注入合成错误帧 → 通知 → 断上游 → 结束输出流 */
  const failWithErrorFrame = (
    frame: StreamError,
    reason: 'inactivity' | 'upstream_disconnected',
  ): void => {
    if (finished) return;
    finished = true;
    clearTimer();
    emit({ type: 'aborted', reason });
    // 错误帧转换：内部错误（超时/断流）→ OpenAI 兼容 SSE 帧，客户端行为一致
    tryEnqueue(
      enc(`data: ${JSON.stringify({ error: { code: frame.code, type: frame.type, message: frame.detail } })}\n\n`),
    );
    emit({
      type: 'done',
      usage: scanner.getUsage(),
      errorFrame: frame,
      bytesRelayed,
      terminated: reason,
    });
    void reader.cancel().catch(() => {});
    tryClose();
  };

  const finishOk = (): void => {
    if (finished) return;
    finished = true;
    clearTimer();
    emit({
      type: 'done',
      usage: scanner.getUsage(),
      errorFrame: scanner.getErrorFrame(),
      bytesRelayed,
      terminated: undefined, // 正常结束
    });
    tryClose();
  };

  /** 定时器检查：inactivity 断流优先，其次心跳注入（仅事件边界） */
  const check = (): void => {
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
      tryEnqueue(enc(': keep-alive\n\n'));
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start() {
      timer = setInterval(check, checkIntervalMs);
      nextRead = reader.read();
    },
    async pull(ctrl) {
      controller = ctrl;
      if (finished || pulling || !nextRead) return;
      pulling = true;
      try {
        const result = await nextRead;
        nextRead = null;
        if (finished) return;
        if (result.done) {
          finishOk();
          return;
        }
        lastDataAt = Date.now();
        scanner.consume(result.value); // 旁路扫描（不消费流），更新 usage/错误帧/事件边界
        tryEnqueue(result.value);
        if (finished) return;
        nextRead = reader.read();
      } catch (err) {
        // 上游读失败（连接中断等）→ 错误帧转换，不重试（流开始后失败发错误帧，见 with-retry 注释）
        failWithErrorFrame(
          { code: 'upstream_disconnected', detail: err instanceof Error ? err.message : String(err) },
          'upstream_disconnected',
        );
      } finally {
        pulling = false;
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      clearTimer();
      emit({ type: 'aborted', reason: 'client_disconnect' });
      emit({
        type: 'done',
        usage: scanner.getUsage(),
        errorFrame: scanner.getErrorFrame(),
        bytesRelayed,
        terminated: 'client_disconnect',
      });
      await reader.cancel(reason);
    },
  });

  return {
    stream,
    onEvent: (cb) => {
      listeners.push(cb);
    },
  };
}
