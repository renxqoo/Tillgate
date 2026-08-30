/**
 * OTel 绑定的 TracePort（inference 阶段 span 的装配面实现；observability SDK 面
 * 再出口直通）：span 嵌套由 OTel 活动上下文决定——网关热路径下父 = otel 中间件的
 * 请求根 span；off 模式为 no-op tracer，零开销。
 *
 * captureRoot：从请求作用域存储（requestTraceStorage）取根上下文——后台终态收尾
 * （流式结算）的 span 直挂根 span 并计入根生命周期（不再沿用已结束的
 * upstream.attempt 异步上下文，2026-08-24 探针实证的孤儿/时窗逃逸根因）。
 */
import type { TracePort, TraceRoot } from '@tillgate/inference';
import { context, getTracer, withAsyncSpan, SpanStatusCode } from '@tillgate/observability';
import { requestTraceStorage } from '../http/middleware/request-trace';

const tracer = getTracer('gateway.pipeline');

/** 非 HTTP 语境（worker/测试直调等无请求作用域）：直跑，不改变嵌套语义 */
const detachedRoot: TraceRoot = {
  runInBackground: (fn) => fn(),
};

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
  captureRoot: (): TraceRoot => {
    const store = requestTraceStorage.getStore();
    if (store == null) return detachedRoot;
    return {
      runInBackground: (fn) => {
        const task = context.with(store.rootContext, fn);
        store.coordinator.add(task);
        return task;
      },
    };
  },
};
