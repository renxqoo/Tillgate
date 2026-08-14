import { remoteParentContext, type Tracer, SpanStatusCode } from '@ai-gateway/core';
import type { SettlementProcessorOptions } from '@ai-gateway/ledger';

/**
 * 结算遥测（阶段2：worker 扣费入链路）：
 * 以 billing_requests.trace_parent（gateway 授权时落列的根 traceparent）为远端父
 * 创建 billing.settle span——「扣费」出现在请求的同一条 trace 里。
 * 无 trace_parent（历史行）时不产孤儿 span；OTEL off 时 no-op tracer 零开销。
 */
export function settleTelemetry(
  tracer: Tracer,
): NonNullable<SettlementProcessorOptions['telemetry']> {
  return {
    settle: async (claim, next) => {
      const parent = remoteParentContext(claim.traceParent);
      if (!parent) return next();
      const span = tracer.startSpan('billing.settle', {}, parent);
      try {
        const result = await next();
        span.setAttributes({
          'request.id': claim.requestId,
          'billing.state': result.outcome,
          // 实扣金额（元，string，永不 round）
          'billing.amount': result.amount,
          'billing.calculated_amount': result.calculatedAmount,
          'usage.input_tokens': claim.receipt.usage.inputTokens,
          'usage.cached_input_tokens': claim.receipt.usage.cachedInputTokens,
          'usage.output_tokens': claim.receipt.usage.outputTokens,
          'channel.key': claim.receipt.channelKey,
          'ai.model': claim.receipt.realModel,
          'billing.settlement_attempt': claim.attempt,
        });
        if (result.outcome !== 'settled') {
          span.setStatus({ code: SpanStatusCode.ERROR, message: result.outcome });
        }
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    },
  };
}
