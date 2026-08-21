import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  trace,
  metrics,
  context,
  type Tracer,
  type Span,
  type Meter,
  type Context,
  type SpanContext,
  SpanStatusCode,
} from '@opentelemetry/api';
import type { Logger } from './logger.js';

// Re-export OTel API（SDK 未启动时返回 no-op，业务代码无条件可用）
export {
  trace,
  metrics,
  context,
  type Tracer,
  type Span,
  type Meter,
  type Context,
  type SpanContext,
  SpanStatusCode,
};

/**
 * 链路追踪模式：
 *   - off     关闭（生产无观测栈时）
 *   - memory  进程内环形缓冲 + 内置查看页（/debug/traces）：零基建，开发默认
 *   - console 每次 span 结束打一行结构化日志（可 grep，适合 CI/无浏览器场景）
 *   - otlp    导出 OTLP collector（生产观测栈）
 */
export type OtelMode = 'off' | 'memory' | 'console' | 'otlp';

export interface InitOtelOptions {
  serviceName: string;
  serviceVersion?: string;
  mode: OtelMode;
  /** OTLP HTTP 端点（collector），如 http://otel-collector:4318；mode=otlp 时必填 */
  endpoint?: string;
  /** mode=console 时的日志出口 */
  logger?: Logger;
  /** OTLP 推送鉴权（Bearer）：缺省回落 env TRACE_RECEIVER_TOKEN——与接收端同键同值，
   *  .env 一处配置两端自动对齐；接收端生产强制验令牌，推送端缺此值 = span 全部 401 拒收 */
  authToken?: string;
}

// ---------- 内存环形缓冲（mode=memory）：最近 N 条 trace，供内置查看页 ----------

export interface ViewableSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: Array<{ name: string; timeMs: number; attributes?: Record<string, unknown> }>;
  service: string;
}

export interface ViewableTrace {
  traceId: string;
  rootName: string;
  startTimeMs: number;
  durationMs: number;
  spanCount: number;
  hasError: boolean;
  services: string[];
  spans: ViewableSpan[];
}

const MAX_TRACES = 200;
const MAX_SPANS_TOTAL = 4_000;

const traces = new Map<string, ViewableSpan[]>();
let totalSpans = 0;

function snapshot(span: ReadableSpan): ViewableSpan {
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? '',
    name: span.name,
    startTimeMs: span.startTime[0] * 1_000 + span.startTime[1] / 1_000_000,
    endTimeMs: span.endTime[0] * 1_000 + span.endTime[1] / 1_000_000,
    durationMs:
      (span.endTime[0] - span.startTime[0]) * 1_000 +
      (span.endTime[1] - span.startTime[1]) / 1_000_000,
    attributes: { ...span.attributes },
    status: { code: span.status.code, message: span.status.message },
    events: span.events.map((e) => ({
      name: e.name,
      timeMs: e.time[0] * 1_000 + e.time[1] / 1_000_000,
      attributes: e.attributes as Record<string, unknown> | undefined,
    })),
    service: span.resource.attributes['service.name'] as string,
  };
}

function evictIfNeeded(): void {
  const oldest = [...traces.keys()];
  while ((traces.size > MAX_TRACES || totalSpans > MAX_SPANS_TOTAL) && oldest.length > 0) {
    const key = oldest.shift()!;
    totalSpans -= traces.get(key)?.length ?? 0;
    traces.delete(key);
  }
}

/** 内存 span 处理器：span 结束即入环形缓冲（按 trace 分组，淘汰最旧） */
export class InMemorySpanProcessor implements SpanProcessor {
  onStart(): void {
    /* 只在 onEnd 快照，避免持有活动对象 */
  }
  onEnd(span: ReadableSpan): void {
    const snap = snapshot(span);
    const list = traces.get(snap.traceId) ?? [];
    list.push(snap);
    traces.set(snap.traceId, list);
    totalSpans += 1;
    evictIfNeeded();
  }
  shutdown(): Promise<void> {
    traces.clear();
    totalSpans = 0;
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/** 读取最近 traces（查看页数据源）：按根 span 开始时间倒序 */
export function getRecentTraces(limit = 50): ViewableTrace[] {
  const grouped: ViewableTrace[] = [];
  for (const spans of traces.values()) {
    if (spans.length === 0) continue;
    const root =
      spans.find((s) => !s.parentSpanId || !spans.some((o) => o.spanId === s.parentSpanId)) ??
      spans[0]!;
    grouped.push({
      traceId: root.traceId,
      rootName: root.name,
      startTimeMs: Math.min(...spans.map((s) => s.startTimeMs)),
      durationMs:
        Math.max(...spans.map((s) => s.endTimeMs)) - Math.min(...spans.map((s) => s.startTimeMs)),
      spanCount: spans.length,
      hasError: spans.some((s) => s.status.code === SpanStatusCode.ERROR),
      services: [...new Set(spans.map((s) => s.service))],
      spans: spans.toSorted((a, b) => a.startTimeMs - b.startTimeMs),
    });
  }
  return grouped.toSorted((a, b) => b.startTimeMs - a.startTimeMs).slice(0, limit);
}

/** 清空缓冲（查看页「清空」按钮用） */
export function clearRecentTraces(): void {
  traces.clear();
  totalSpans = 0;
}

// ---------- 日志处理器（mode=console）：每次 span 结束一行结构化日志 ----------

/** 日志 span 处理器：一行摘要（traceId/name/时长/关键属性），可 grep */
export class LogSpanProcessor implements SpanProcessor {
  private readonly logger: Logger;
  constructor(logger: Logger) {
    this.logger = logger;
  }
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
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
    if (isError) this.logger.warn(line, 'span');
    else this.logger.info(line, 'span');
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------- 初始化 ----------

/**
 * OTel SDK 初始化（应用启动时调用一次）。
 *   - off：完全 no-op（业务代码拿到的 tracer/meter 无开销）
 *   - memory：InMemorySpanProcessor（内置 /debug/traces 查看页数据源）
 *   - console：LogSpanProcessor（一行结构化日志）
 *   - otlp：BatchSpanProcessor → OTLP collector（traces + metrics）
 */
export function initOtel(initOtelOptions: InitOtelOptions) {
  const { serviceName, serviceVersion = '0.1.0', mode, endpoint, logger } = initOtelOptions;
  if (mode === 'off') {
    return { shutdown: async () => {}, mode } as const;
  }
  if (mode === 'otlp' && !endpoint) {
    throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT must be configured when OTEL_TRACES_MODE=otlp');
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
  });

  // 推送令牌解析：显式参数优先，缺省回落共享 env 键（与接收端 TRACE_RECEIVER_TOKEN 同源）
  const authToken = initOtelOptions.authToken ?? process.env.TRACE_RECEIVER_TOKEN;

  const sdk = new NodeSDK({
    resource,
    spanProcessors:
      mode === 'memory'
        ? [new InMemorySpanProcessor()]
        : mode === 'console'
          ? [new LogSpanProcessor(logger ?? (console as unknown as Logger))]
          : [
              new BatchSpanProcessor(
                new OTLPTraceExporter({
                  url: `${endpoint}/v1/traces`,
                  ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {}),
                }),
              ),
            ],
    ...(mode === 'otlp'
      ? {
          metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: `${endpoint}/v1/metrics`,
              ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {}),
            }),
            exportIntervalMillis: 10_000,
          }),
        }
      : {}),
  });

  sdk.start();
  return {
    mode,
    shutdown: () => sdk.shutdown(),
  } as const;
}

/** 获取 tracer（SDK 未启动时返回全局 no-op tracer） */
export function getTracer(name = 'ai-gateway'): Tracer {
  return trace.getTracer(name);
}

// ---------- W3C traceparent（跨进程 trace 关联：gateway 授权落列 ↔ worker 结算挂回） ----------

/** 根 span 上下文 → `00-{traceId}-{spanId}-01`；无效上下文（no-op tracer）返回 null */
export function formatTraceParent(sc: SpanContext): string | null {
  if (!trace.isSpanContextValid(sc)) return null;
  return `00-${sc.traceId}-${sc.spanId}-01`;
}

/** 解析 traceparent 为远端父 Context；空/格式非法返回 undefined */
export function remoteParentContext(traceParent: string | null | undefined): Context | undefined {
  if (typeof traceParent !== 'string') return undefined;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(traceParent);
  if (!m) return undefined;
  return trace.setSpan(
    context.active(),
    trace.wrapSpanContext({ traceId: m[1]!, spanId: m[2]!, isRemote: true, traceFlags: 1 }),
  );
}

/** 获取 meter（SDK 未启动时返回全局 no-op meter） */
export function getMeter(name = 'ai-gateway'): Meter {
  return metrics.getMeter(name);
}

/**
 * 阶段 span 助手：fn 包在 context.with 里——内部再嵌 withAsyncSpan 自然成树
 * （父 = 当前 active span，网关热路径即 otel 中间件的请求根 span）。
 * 异常 → span 记 ERROR + recordException 后原样上抛（观测不吞错）。
 * SDK 未启动 = no-op tracer，零开销。
 */
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
