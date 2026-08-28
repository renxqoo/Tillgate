import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * 日志 span 处理器(mode=console):每次 span 结束一行结构化日志(可 grep,适合 CI/无浏览器场景)。
 *
 * SpanLogSink 是结构化最小形状——runtime 的 pino Logger 结构兼容,装配自然传入;
 * 不为借用一个类型引入 runtime 依赖。
 */
export interface SpanLogSink {
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
}

export function createLogSpanProcessor(logger: SpanLogSink): SpanProcessor {
  return {
    onStart() {},
    onEnd(span: ReadableSpan) {
      const durationMs =
        (span.endTime[0] - span.startTime[0]) * 1_000 +
        (span.endTime[1] - span.startTime[1]) / 1_000_000;
      const isError = span.status.code === SpanStatusCode.ERROR;
      const line = {
        traceId: span.spanContext().traceId,
        span: span.name,
        durationMs: Math.round(durationMs),
        ...(isError ? { error: span.status.message ?? 'error' } : {}),
        ...(Object.keys(span.attributes).length > 0 ? { attrs: span.attributes } : {}),
      };
      if (isError) logger.warn(line, 'span');
      else logger.info(line, 'span');
    },
    async shutdown() {},
    async forceFlush() {},
  };
}
