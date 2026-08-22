/**
 * 流式首帧探测（D3：流式空完成判定 + #6643 同类首帧错误识别）。
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

export async function peekFirstChunk(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PeekResult> {
  // 已 abort 的信号不会触发 addEventListener——不提前退出会让 read() 永久挂起
  if (opts.signal?.aborted) {
    void body.cancel().catch(() => {});
    throw new Error('peek aborted before start');
  }
  const [branchA, branchB] = body.tee();
  const reader = branchA.getReader();
  // branchB（完整上游 body）未被调用方接管时必须释放：
  // 未消费未取消的 tee 分支会让 undici 连接永久保持打开（连接池耗尽）
  const discard = (): void => {
    void branchB.cancel().catch(() => {});
  };
  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  // 首字节预算：connectMs 只覆盖到响应头；本超时覆盖「headers 后 body 首字节」
  // （relay-stream 的 inactivity 只于首 chunk 后武装——此处是唯一覆盖点）
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const readPromise = reader.read();
  // 竞态安全：超时后 read 再 reject 不得变成 unhandledRejection
  void readPromise.catch(() => {});
  const timeoutPromise =
    opts.timeoutMs !== undefined
      ? new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(
            () => reject(new PeekTimeoutError(opts.timeoutMs!)),
            opts.timeoutMs!,
          );
        })
      : null;
  try {
    const { done, value } = timeoutPromise
      ? await Promise.race([readPromise, timeoutPromise])
      : await readPromise;
    void reader.cancel().catch(() => {});
    if (done || !value || value.length === 0) {
      discard();
      return { done: true };
    }
    return { done: false, first: value, rest: branchB };
  } catch (err) {
    void reader.cancel().catch(() => {});
    discard();
    throw err;
  } finally {
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 首帧错误检测（#6643 同类）：首 chunk 内含完整 `data: {"error": ...}` 帧时，
 * 把扫描器捕获的错误帧还原为 body 形状并做无状态码分类。
 * 只看首帧（与 peek 同界）——错误帧跨 chunk 分割时检测不到，
 * 退回 relay-stream 的中流错误帧语义（terminated）兜底。
 */
export function firstChunkStreamError(first: Uint8Array): UpstreamError | null {
  const scanner = new SseScanner();
  scanner.consume(first);
  const frame = scanner.getErrorFrame();
  if (!frame) return null;
  return statusFallbackError(200, {
    error: {
      code: frame.code,
      ...(frame.type !== undefined ? { type: frame.type } : {}),
      ...(frame.detail !== undefined ? { message: frame.detail } : {}),
    },
  });
}
