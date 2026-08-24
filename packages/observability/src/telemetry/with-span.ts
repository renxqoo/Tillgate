import { context, trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';

/**
 * 阶段 span 助手:fn 包在 context.with 里——内部再嵌 withAsyncSpan 自然成树
 * (父 = 当前 active span,网关热路径即 otel 中间件的请求根 span)。
 * 异常 → span 记 ERROR + recordException 后原样上抛(观测不吞错)。
 * SDK 未启动 = no-op tracer,零开销。
 */
// eslint-disable-next-line max-params -- 导出 API,apps/gateway 等跨包调用点沿用 tracer/name/attributes/fn 四参形态,改 options 会放大契约 diff
export async function withAsyncSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, { attributes });
  try {
    const out = await context.with(trace.setSpan(context.active(), span), () => fn(span));
    span.end();
    return out;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error) span.recordException(error);
    span.end();
    throw error;
  }
}
