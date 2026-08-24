import type { UsageReceipt } from '../domain/usage/receipt';
import type { BillingPort } from '../ports/billing';
import type { TracePort } from '../ports/trace';

/**
 * 终态 signal 退避重试（v1 settle-retry.ts 迁移；上限参数化，整段包
 * billing.settle_signal span——耗尽标 ERROR 后如实返回 false）：
 * 结算落账的瞬时 DB 抖动不再把已交付请求漏收——流式路径重试期间续租定时器不停
 * （调用方约定：alive 保持到结算收尾），recover 不会中途误释放；耗尽返回 false
 * 由调用方兜底（流式 = 停租约交 recover 释放记损；非流式 = 抛 finalize_unavailable）。
 */
export async function signalSucceededWithRetry(
  deps: {
    billing: BillingPort;
    settleSignal: { attempts: number; baseDelayMs: number; maxDelayMs: number };
    trace: TracePort;
    onError?: (error: unknown, context: string) => void;
  },
  requestId: string,
  receipt: UsageReceipt,
): Promise<boolean> {
  const { attempts, baseDelayMs, maxDelayMs } = deps.settleSignal;
  return await deps.trace.withSpan(
    'billing.settle_signal',
    { 'request.id': requestId },
    async (span) => {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          await deps.billing.signal({ type: 'request_succeeded', requestId, receipt });
          return true;
        } catch (error) {
          deps.onError?.(
            error,
            `signal request_succeeded request=${requestId} attempt=${attempt}/${attempts}`,
          );
          if (attempt === attempts) {
            span.setAttributes({ 'settle.attempts': attempt });
            span.setStatus({ code: 'error', message: 'signal retries exhausted' });
          }
          if (attempt < attempts) {
            await new Promise((resolve) => {
              setTimeout(resolve, Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
            });
          }
        }
      }
      return false;
    },
  );
}
