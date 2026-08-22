import { context, trace, type Context, type SpanContext } from '@opentelemetry/api';

/**
 * W3C traceparent(跨进程 trace 关联:gateway 授权落列 ↔ worker 结算挂回)。
 */

/** 根 span 上下文 → `00-{traceId}-{spanId}-01`;无效上下文(no-op tracer)返回 null */
export function formatTraceParent(sc: SpanContext): string | null {
  if (!trace.isSpanContextValid(sc)) return null;
  return `00-${sc.traceId}-${sc.spanId}-01`;
}

/** 解析 traceparent 为远端父 Context;空/格式非法返回 undefined(拒绝面:非 00 版本/非 hex/flags 非 0[01]) */
export function remoteParentContext(traceParent: string | null | undefined): Context | undefined {
  if (typeof traceParent !== 'string') return undefined;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(traceParent);
  if (!m) return undefined;
  return trace.setSpan(
    context.active(),
    trace.wrapSpanContext({ traceId: m[1]!, spanId: m[2]!, isRemote: true, traceFlags: 1 }),
  );
}
