/**
 * 同渠道重试：指数退避 + jitter + deadline + maxAttempts（含空完成重试）（骨架）
 * 注意：重试仅限「首字节前」；流开始后失败 → 发错误帧，不重试（由 relay-stream 保证）
 */
// TODO(ai): 实现 withRetry(fn, opts)：
//   - baseDelayMs × 2^n + jitter（jitterRatio 比例）
//   - 总 deadlineMs 截断
//   - 仅 retryable=true 的错误重试；空完成重试 ≤2 次
export function backoffDelayMs(attempt: number, base: number, max: number, jitterRatio: number): number {
  const exp = Math.min(base * 2 ** attempt, max)
  const jitter = exp * jitterRatio * Math.random()
  return Math.round(exp + jitter)
}
