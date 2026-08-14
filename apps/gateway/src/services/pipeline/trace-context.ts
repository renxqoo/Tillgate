import type { Context, Span } from '@opentelemetry/api';

/**
 * 管线链路上下文（组件化下沉）：
 *
 * - RequestTraceContext：请求级。run() 入口捕获的 OTel Context（含根 span），
 *   供流式生命周期结束后创建的收尾 span（billing.finalize）作为父——
 *   根 span 可能已结束，但父子关系依然成立，trace 不断链。
 * - AttemptTraceContext：渠道尝试级。附加上游 span，TTFB/状态码/usage 写入点。
 */

export interface RequestTraceContext {
  requestContext: Context;
}

export interface AttemptTraceContext extends RequestTraceContext {
  upSpan: Span;
}
