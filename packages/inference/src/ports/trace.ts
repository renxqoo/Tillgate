/**
 * trace port（跨能力经消费方 port——重构方案 §5.2；v1 管线 withAsyncSpan 面的 v2 形态）：
 * inference 各阶段 span 经此口发出，装配绑 OTel 实现（gateway adapters/trace-port.ts）；
 * 未注入 = no-op 零开销。span 命名与完整清单见 docs/observability.md §3。
 * 嵌套语义：实现负责把 fn 包进 span 上下文——内部再嵌 withSpan 自然成树
 * （父 = 当前活动 span，网关热路径即 otel 中间件的请求根 span）。
 */

/** span 属性值域（OTel 属性标量三态） */
export type TraceAttributeValue = string | number | boolean;
export type TraceAttributes = Record<string, TraceAttributeValue>;

/** 活动 span 句柄（实现侧仅此两个动词；no-op 实现为空操作） */
export interface SpanHandle {
  setAttributes(attributes: TraceAttributes): void;
  setStatus(input: { code: 'ok' | 'error'; message?: string }): void;
}

export interface TracePort {
  withSpan<T>(
    name: string,
    attributes: TraceAttributes,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T>;
}

/** 未注入装配时的 no-op（异常语义与真实实现一致：观察不吞错，原样上抛） */
export const noopTrace: TracePort = {
  withSpan: async (_name, _attributes, fn) =>
    await fn({
      setAttributes: () => undefined,
      setStatus: () => undefined,
    }),
};
