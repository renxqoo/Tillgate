/**
 * 终态 signal 退避重试（流式/非流式尝试共用的结算收尾）：
 * 结算落账的瞬时 DB 抖动不再把已交付请求漏收——流式路径重试期间续租定时器不停
 * （调用方约定），recover 不会中途误释放；耗尽返回 false 由调用方兜底
 * （流式 = 停租约交 recover 释放记损；非流式 = 上抛 500）。
 */
import { getTracer, SpanStatusCode, withAsyncSpan } from '@ai-gateway/core';
import type { UsageReceipt } from '@ai-gateway/domain';
import type { BillingDomain, RunContext } from '@ai-gateway/service';

export const SIGNAL_FINALIZE_ATTEMPTS = 5;
const SIGNAL_FINALIZE_BASE_DELAY_MS = 500;

export async function signalSucceededWithRetry(
  billing: BillingDomain,
  ctx: RunContext,
  requestId: string,
  receipt: UsageReceipt,
  onError: (error: unknown, context: string) => void,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? SIGNAL_FINALIZE_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? SIGNAL_FINALIZE_BASE_DELAY_MS;
  // 结算信号 span：流式/非流式共用；重试逐次 addEvent，耗尽置 ERROR（漏收可见）
  return withAsyncSpan(getTracer('gateway.pipeline'), 'billing.settle_signal', {
    'request.id': requestId,
    ...(receipt.userId != null ? { 'user.id': receipt.userId } : {}),
    ...(receipt.externalModel != null ? { 'ai.model': receipt.externalModel } : {}),
    ...(receipt.channelKey != null ? { 'channel.key': receipt.channelKey } : {}),
    ...(receipt.usage
      ? {
          'usage.estimated': receipt.usage.estimated,
          'tokens.input': receipt.usage.inputTokens,
          'tokens.output': receipt.usage.outputTokens,
        }
      : {}),
    'billing.stream': receipt.stream,
  }, async (span) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await billing.signal(ctx, { type: 'request.succeeded', requestId, receipt });
        return true;
      } catch (error) {
        onError(error, `signal request.succeeded request=${requestId} attempt=${attempt}/${attempts}`);
        if (attempt < attempts) {
          span.addEvent('signal.retry', { attempt });
          await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, baseDelayMs * 2 ** (attempt - 1))));
        }
      }
    }
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'signal retries exhausted' });
    return false;
  });
}
