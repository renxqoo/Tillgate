/**
 * OTel 请求 span 中间件（SDK 面归 @tillgate/observability 再出口）：
 * 每请求一条根 span `METHOD /path`；跳过探针路径；requestId 后挂（span 属性依赖它）。
 *
 * 根 span 生命周期 = 请求生命周期（trace-probe 树核对的时窗不变量）：
 * - 非流式：await next() 后等后台收尾（coordinator）再闭合；
 * - 流式：响应体包一层接力流——体送完/出错/取消时等后台收尾再闭合
 *   （不阻塞响应返回：闭合完全异步，长流的根 span 时长 ≈ 全程而非 TTFT）；
 * - 请求作用域上下文（根上下文 + coordinator）经 requestTraceStorage 下传，
 *   后台终态收尾（流式结算）经 TracePort.captureRoot() 挂根 span 并计入等待。
 * off 模式 no-op（observability initOtel 契约）。
 */
import type { MiddlewareHandler } from 'hono';
import { context, getTracer, trace, SpanStatusCode, type Span } from '@tillgate/observability';
import type { AuthContext, AuthEnv } from './api-key';
import {
  RequestTraceCoordinator,
  requestTraceStorage,
  TRACE_FINALIZE_BOUND_MS,
} from './request-trace';

const SKIPPED = new Set(['/healthz', '/readyz', '/livez']);

/** 请求后观察回填：状态码 + 鉴权属性 + ≥5xx 置 ERROR（观察面旁路，不碰数据面） */
function observeResponse(span: Span | undefined, auth: AuthContext | undefined, status: number) {
  span?.setAttribute('http.status_code', status);
  if (auth != null) {
    span?.setAttribute('user.id', auth.userId);
    if (auth.apiKeyId != null) span?.setAttribute('api_key.id', auth.apiKeyId);
  }
  if (status >= 500) span?.setStatus({ code: SpanStatusCode.ERROR });
}

/** 流式收口宽限拍：取消路径的中止传播链（pipeTo 拒绝 → 终态事件 → 结算登记）
 * 是纯微任务，两个 setImmediate 拍内必达——空集快照在此之前不放行 */
const TRACE_CLOSE_GRACE_TICKS = 2;

/** 闭合根 span：先等登记的后台收尾（有界 + 宽限拍），保证子 span 时窗全部落内 */
function closeSpanAfterFinalizers(span: Span, coordinator: RequestTraceCoordinator): void {
  void coordinator.wait(TRACE_FINALIZE_BOUND_MS, TRACE_CLOSE_GRACE_TICKS).finally(() => {
    span.end();
  });
}

/**
 * 流式体接力：逐块透传，流终止（完成/出错/取消）时收口根 span。
 * 纯透传不加变换——SSE 字节序列与上游完全一致。
 */
function relayBodyToEndSpan(
  span: Span,
  body: ReadableStream<Uint8Array>,
  coordinator: RequestTraceCoordinator,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    closeSpanAfterFinalizers(span, coordinator);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        // 客户端主动取消（中断在途 read）不是服务错误——已收口的流不再改状态
        if (!closed) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        finish();
        controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}

export function otelMiddleware(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const { path } = c.req;
    if (SKIPPED.has(path)) {
      await next();
      return;
    }
    const spanName = `${c.req.method} ${path}`;
    const span = getTracer('gateway').startSpan(spanName);
    const rootContext = trace.setSpan(context.active(), span);
    const coordinator = new RequestTraceCoordinator();
    const handler = async (): Promise<Response | undefined> => {
      span.setAttribute('http.method', c.req.method);
      span.setAttribute('http.target', path);
      const requestId = c.get('requestId');
      if (requestId != null) span.setAttribute('request.id', requestId);
      let deferredByStream = false;
      try {
        await next();
        observeResponse(span, c.get('auth'), c.res?.status ?? 0);
        // 仅 SSE 流式响应延后闭合（运行时所有 Response.body 都可能是流——按
        // content-type 判别，JSON 体不挂接力流：无人消费的体会让收口永不触发）
        const contentType = c.res?.headers.get('content-type') ?? '';
        if (c.res?.body instanceof ReadableStream && contentType.includes('text/event-stream')) {
          deferredByStream = true;
          c.res = new Response(relayBodyToEndSpan(span, c.res.body, coordinator), c.res);
          return c.res;
        }
        await coordinator.wait(TRACE_FINALIZE_BOUND_MS);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        throw error;
      } finally {
        if (!deferredByStream) span.end();
      }
    };
    // 双层作用域：OTel 根上下文（阶段 span 自然成树挂根）+ 请求作用域存储
    // （captureRoot 捕根 + coordinator 计入根生命周期）
    return requestTraceStorage.run({ rootContext, coordinator }, () =>
      context.with(rootContext, handler),
    );
  };
}
