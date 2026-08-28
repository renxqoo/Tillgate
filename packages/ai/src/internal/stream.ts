/**
 * 流式首帧探测：流式空完成判定 + 首帧错误识别。
 *
 * 用途：chatStream 拿到 200 Response 后、交给 relayStream 之前，预读首个 chunk。
 *   - 上游立即 EOF（无任何 data 帧）→ 空完成，可在 withRetry 内按 empty 重试（≤ emptyCompletionRetries）。
 *   - 首帧含完整错误帧（200 + 流内错误对象）→ 转换为 UpstreamError，进入 withRetry/
 *     failEarly（首字节尚未发给客户端，重试与换渠道都安全）。
 *   - 有首帧 → 把 first + 剩余 reader 包装成新 ReadableStream，无缝交给 relayStream。
 *
 * 与 readBody 同样的 signal 接入：abort 时 cancel reader，让 pending 的 read() 退出（不 hang）。
 */

import type { UpstreamError } from '../types';
import { SseScanner } from '../transport/sse-parser';
import { statusFallbackError } from '../errors/fallback';

export interface PeekResult {
  /** true = 上游空流（EOF，无任何 chunk） */
  done: boolean;
  /** 首帧（done=false 时有值） */
  first?: Uint8Array;
  /** 剩余流：first 之后的内容（含 first 已被预取的语义——rest 会先吐 first 再继续读上游） */
  rest?: ReadableStream<Uint8Array>;
}

/**
 * 预读首个 chunk 检测空流，但不消费 body（用 tee 分流）。
 *   branchA 读首块检测空流 → 立即 cancel（不再读）
 *   branchB 是完整流（含首块），交给 relayStream pipeTo（保持流式特性）
 */
/** 首字节预算耗尽（上游发完 headers 后挂起）：retryable 超时类错误 */
export class PeekTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`no first byte from upstream within ${timeoutMs}ms`);
    this.name = 'PeekTimeoutError';
  }
}

/** 首字节预算定时（promise 与清除器成对返回——调用方在 finally 里 clear 防泄漏） */
function armFirstByteTimeout(timeoutMs: number): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PeekTimeoutError(timeoutMs)), timeoutMs);
  });
  return {
    promise,
    clear: () => {
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/** 上游字节 reader 的最小结构面(node stream/web 与全局 DOM 形名义不同,按结构钉死) */
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

/**
 * 回放式 rest：first 已被预读，包装流先吐 first 再按需续读原始 reader
 * （pull 驱动——与 pipeTo/手动读都兼容；取消透传给原始 reader 归还上游连接）。
 */
function replayRestStream(reader: ByteReader, firstChunk: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(firstChunk);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        // value 形:node stream/web 与全局 DOM 形的类型并集,运行时恒为 Uint8Array
        if (done) controller.close();
        else controller.enqueue(value as Uint8Array);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}

export async function peekFirstChunk(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PeekResult> {
  // 已 abort 的信号不会触发 addEventListener——不提前退出会让 read() 永久挂起
  if (opts.signal?.aborted) {
    void body.cancel().catch(() => {});
    throw new Error('peek aborted before start');
  }
  // 不用 tee()：现代 WHATWG 语义下单分支 cancel 要等两分支齐 cancel 才 resolve，
  // 且「一分支 cancel 未决」会让另一分支的 pipeTo 停摆（bun 1.4 / node 22/24 实测）——
  // 直读原始 reader + 回放式 rest 包装契约不变（rest 先吐 first 再续读上游），
  // 且不产生待释放的 tee 分支（undici 连接随原始 reader 的消费/取消自然归还）。
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  // 首字节预算：connectMs 只覆盖到响应头；本超时覆盖「headers 后 body 首字节」
  // （relay-stream 的 inactivity 只于首 chunk 后武装——此处是唯一覆盖点）
  const timeout = opts.timeoutMs !== undefined ? armFirstByteTimeout(opts.timeoutMs) : null;
  const readPromise = reader.read();
  // 竞态安全：超时后 read 再 reject 不得变成 unhandledRejection
  void readPromise.catch(() => {});
  try {
    const first =
      timeout !== null ? await Promise.race([readPromise, timeout.promise]) : await readPromise;
    if (first.done || !first.value || first.value.length === 0) {
      void reader.cancel().catch(() => {});
      return { done: true };
    }
    const firstChunk = first.value;
    return { done: false, first: firstChunk, rest: replayRestStream(reader, firstChunk) };
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    timeout?.clear();
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 首帧错误检测：首 chunk 内含完整 `data: {"error": ...}` 帧时，
 * 把扫描器捕获的错误帧还原为 body 形状并做无状态码分类。
 * 只看首帧（与 peek 同界）——错误帧跨 chunk 分割时检测不到，
 * 退回 relay-stream 的中流错误帧语义（terminated）兜底。
 */
export function firstChunkStreamError(first: Uint8Array): UpstreamError | null {
  const body = firstChunkErrorBody(first);
  return body !== null ? statusFallbackError(200, body) : null;
}

/**
 * 首帧错误体的信封还原：create-ai 的 mapError 拿到的是
 * 原始 SSE 文本（"data: {...}\n\n"），tryParseJson 对该前缀恒失败会把
 * vendorCode 丢成 status 兜底（insufficient_quota → invalid_request 误分类）。
 * 此处用扫描器剥壳还原 {error:{code,type,message}} 形状供厂商错误表查表。
 */
export function firstChunkErrorBody(first: Uint8Array): Record<string, unknown> | null {
  const scanner = new SseScanner();
  scanner.consume(first);
  const frame = scanner.getErrorFrame();
  if (!frame) return null;
  return {
    error: {
      code: frame.code,
      ...(frame.type !== undefined ? { type: frame.type } : {}),
      ...(frame.detail !== undefined ? { message: frame.detail } : {}),
    },
  };
}
