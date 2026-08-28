/**
 * OTel 绑定的 TracePort（inference 阶段 span 的装配面实现；observability SDK 面
 * 再出口直通）：span 嵌套由 OTel 活动上下文决定——网关热路径下父 = otel 中间件的
 * 请求根 span；off 模式为 no-op tracer，零开销。
 */
import type { TracePort } from '@tillgate/inference';
import { getTracer, withAsyncSpan, SpanStatusCode } from '@tillgate/observability';

const tracer = getTracer('gateway.pipeline');

export const otelTracePort: TracePort = {
  withSpan: (name, attributes, fn) =>
    withAsyncSpan(tracer, name, attributes, (span) =>
      fn({
        setAttributes: (a) => span.setAttributes(a),
        setStatus: (s) =>
          span.setStatus(
            s.code === 'error'
              ? {
                  code: SpanStatusCode.ERROR,
                  ...(s.message != null ? { message: s.message } : {}),
                }
              : { code: SpanStatusCode.OK },
          ),
      }),
    ),
};
