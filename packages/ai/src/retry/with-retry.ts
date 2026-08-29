import type { UpstreamError } from '../types';

/**
 * 同渠道重试：指数退避 + jitter + deadline + maxAttempts（含空完成重试）
 * 注意：重试仅限「首字节前」；流开始后失败 → 发错误帧，不重试（由 relay-stream 保证）
 *
 * 退避策略（AWS "Exponential Backoff With Full Jitter"）：
 *   exp = min(base × 2^(attempt-1), max)；延迟 = random(0, exp × (1 + jitterRatio))
 *   - jitterRatio=0 → 固定 exp（无抖动，适合测试）
 *   - jitterRatio=0.25 → 延迟在 [0, exp×1.25] 均匀分布，打散重试风暴
 *   full jitter（下界为 0）避免重试请求同步扎堆，比「exp + 正向抖动」更有效打散
 */

export interface RetryOptions {
  /** 最大尝试次数（含首次），默认 3 */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 抖动比例 [0,1]：延迟在 [0, exp×(1+jitterRatio)] 均匀分布（full jitter） */
  jitterRatio: number;
  /** 总 deadline，超时中止（AbortSignal 传给 fn） */
  deadlineMs: number;
  /** 空完成（200 但无内容）重试次数，默认 2 */
  emptyCompletionRetries: number;
  /** 调用方取消信号；与本地 deadline 合并。 */
  signal?: AbortSignal;
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

/**
 * 计算单次重试退避延迟（full jitter）。
 * @param attempt 已失败的尝试序号（1-based：第 1 次失败后计算第 2 次的延迟）
 * @param base 基础延迟（attempt=1 时 exp=base）
 * @param max 延迟上限（封顶）
 * @param jitterRatio 抖动比例：延迟在 [0, exp×(1+jitterRatio)] 均匀分布
 * @returns 退避毫秒数（≥1，避免 0 延迟的无效定时器）
 */
// eslint-disable-next-line max-params -- 导出的纯数学函数（4 个标量各自带 JSDoc），改对象参数会放大全部调用点与测试 diff
export function backoffDelayMs(
  attempt: number,
  base: number,
  max: number,
  jitterRatio: number,
): number {
  // attempt=1 → 2^0=1 → exp=base；attempt=2 → 2^1=2 → exp=base*2
  const exp = Math.min(base * 2 ** (attempt - 1), max);
  // jitterRatio=0 → 固定 exp（无抖动，确定性退避，便于测试）
  if (jitterRatio <= 0) return exp;
  // full jitter：[1, exp×(1+jitterRatio)]，下界 1ms 避免 0 延迟无效定时器
  const upper = exp * (1 + jitterRatio);
  return Math.max(1, Math.round(Math.random() * upper));
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
  // deadline 计时起点：剩余预算 = deadlineMs − 已耗时（判定必须用剩余而非全量）
  const startedAt = Date.now();
  const controller = new AbortController();
  const deadlineTimer = setTimeout(
    () => controller.abort(new Error('retry deadline exceeded')),
    opts.deadlineMs,
  );
  const signal = opts.signal
    ? AbortSignal.any([controller.signal, opts.signal])
    : controller.signal;
  try {
    let attempts = 0;
    let emptyCount = 0;
    for (;;) {
      attempts += 1;
      const outcome = await fn(attempts, signal);
      if (outcome.ok) return { outcome, attempts };

      const { error } = outcome;
      const canRetryError = error.retryable && attempts < opts.maxAttempts;
      const canRetryEmpty =
        (outcome.empty ?? false) &&
        emptyCount < opts.emptyCompletionRetries &&
        attempts < opts.maxAttempts;
      if (!canRetryError && !canRetryEmpty) return { outcome, attempts };

      if (outcome.empty) emptyCount += 1;
      // Retry-After（rate_limited 专属）是退避下界：早于指数退避重发只会再吃一个 429
      const backoff = backoffDelayMs(attempts, opts.baseDelayMs, opts.maxDelayMs, opts.jitterRatio);
      const delayMs = Math.max(backoff, error.retryAfterMs ?? 0);
      // 有效等待超过剩余 deadline：睡下去只会被 deadline 打断——立即放弃同渠道重试，
      // 把最后错误交回编排层换渠（不把整段同渠道预算耗在注定失败的等待上）
      const remainingMs = opts.deadlineMs - (Date.now() - startedAt);
      if (delayMs > remainingMs) return { outcome, attempts };
      onRetry?.({ attempt: attempts, error, delayMs });
      await sleep(delayMs, signal);
      if (signal.aborted) return { outcome, attempts }; // deadline/调用方取消，不再重试
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
}
