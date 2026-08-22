/**
 * OTel API 词汇再出口:业务代码从本包唯一取用点(SDK 未启动时全局 no-op,无条件可用)。
 * SDK/导出器实现不由此文件出口(init-otel 内部装配)。
 */
import { trace, metrics, context, SpanStatusCode } from '@opentelemetry/api';
import type { Tracer, Span, Meter, Context, SpanContext } from '@opentelemetry/api';

export {
  trace,
  metrics,
  context,
  SpanStatusCode,
  type Tracer,
  type Span,
  type Meter,
  type Context,
  type SpanContext,
};

/** 获取 tracer(SDK 未启动时返回全局 no-op tracer,零开销) */
export function getTracer(name = 'tokenlens'): Tracer {
  return trace.getTracer(name);
}

/** 获取 meter(SDK 未启动时返回全局 no-op meter) */
export function getMeter(name = 'tokenlens'): Meter {
  return metrics.getMeter(name);
}
