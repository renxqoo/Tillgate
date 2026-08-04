import type { UpstreamError } from '../types.js';

/**
 * 同渠道重试：指数退避 + jitter + deadline + maxAttempts（含空完成重试）
 * 注意：重试仅限「首字节前」；流开始后失败 → 发错误帧，不重试（由 relay-stream 保证）
 */

export interface RetryOptions {
  /** 最大尝试次数（含首次），默认 3 */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  /** 总 deadline，超时中止（AbortSignal 传给 fn） */
  deadlineMs: number;
  /** 空完成（200 但无内容）重试次数，默认 2 */
  emptyCompletionRetries: number;
}

/** fn 的返回：成功 / 失败（可重试错误 或 空完成） */
export type AttemptOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: UpstreamError; empty?: boolean };

export interface RetryResult<T> {
  outcome: AttemptOutcome<T>;
  attempts: number;
}

export interface RetryAttemptInfo {
  attempt: number;
  error: UpstreamError;
  delayMs: number;
}

export function backoffDelayMs(
  attempt: number,
  base: number,
  max: number,
  jitterRatio: number,
): number {
  const exp = Math.min(base * 2 ** attempt, max);
  const jitter = exp * jitterRatio * Math.random();
  return Math.round(exp + jitter);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * 重试编排：仅 retryable=true 的错误 与 空完成（≤ emptyCompletionRetries）触发重试；
 * 总 deadline 到（AbortSignal）立即停止。
 */
export async function withRetry<T>(
  fn: (attempt: number, signal: AbortSignal) => Promise<AttemptOutcome<T>>,
  opts: RetryOptions,
  onRetry?: (info: RetryAttemptInfo) => void,
): Promise<RetryResult<T>> {
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), opts.deadlineMs);
  try {
    let attempts = 0;
    let emptyCount = 0;
    for (;;) {
      attempts += 1;
      const outcome = await fn(attempts, controller.signal);
      if (outcome.ok) return { outcome, attempts };

      const { error } = outcome;
      const canRetryError = error.retryable && attempts < opts.maxAttempts;
      const canRetryEmpty =
        (outcome.empty ?? false) &&
        emptyCount < opts.emptyCompletionRetries &&
        attempts < opts.maxAttempts;
      if (!canRetryError && !canRetryEmpty) return { outcome, attempts };

      if (outcome.empty) emptyCount += 1;
      const delayMs = backoffDelayMs(attempts, opts.baseDelayMs, opts.maxDelayMs, opts.jitterRatio);
      onRetry?.({ attempt: attempts, error, delayMs });
      await sleep(delayMs, controller.signal);
      if (controller.signal.aborted) return { outcome, attempts }; // deadline 到，不再重试
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
}
