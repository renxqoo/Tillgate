import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * 内存环形缓冲(mode=memory):最近 N 条 trace,供内置查看页——零基建,开发默认。
 * 工厂闭包实现,可多实例(无模块级全局状态)。
 *
 * 常数内存预算:MAX_TRACES=200 / MAX_SPANS_TOTAL=4000,超限按插入序淘汰最旧 trace 整组。
 */

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

export interface MemoryTraceViewer {
  /** 接入 SDK 的 span 处理器(只读 onEnd 快照,不持活动对象) */
  processor: SpanProcessor;
  /** 最近 traces(查看页数据源):按根 span 开始时间倒序 */
  recent(limit?: number): ViewableTrace[];
  /** 清空缓冲(查看页「清空」按钮用) */
  clear(): void;
}

const MAX_TRACES = 200;
const MAX_SPANS_TOTAL = 4_000;

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

/** 淘汰最旧 trace 直到 trace 条数与总 span 数双上限满足;返回淘汰后的总 span 数 */
function evictOldTraces(traces: Map<string, ViewableSpan[]>, totalSpans: number): number {
  const oldest = [...traces.keys()];
  let total = totalSpans;
  while ((traces.size > MAX_TRACES || total > MAX_SPANS_TOTAL) && oldest.length > 0) {
    const key = oldest.shift();
    if (key === undefined) break;
    total -= traces.get(key)?.length ?? 0;
    traces.delete(key);
  }
  return total;
}

/** 单 trace 的查看页视图模型:根推断(父不在集内)、聚合时长/服务集、时间序 spans */
function toViewableTrace(spans: ViewableSpan[]): ViewableTrace {
  const root =
    spans.find((s) => !s.parentSpanId || !spans.some((o) => o.spanId === s.parentSpanId)) ??
    spans[0];
  if (root === undefined) throw new Error('expected non-empty span group');
  return {
    traceId: root.traceId,
    rootName: root.name,
    startTimeMs: Math.min(...spans.map((s) => s.startTimeMs)),
    durationMs:
      Math.max(...spans.map((s) => s.endTimeMs)) - Math.min(...spans.map((s) => s.startTimeMs)),
    spanCount: spans.length,
    hasError: spans.some((s) => s.status.code === SpanStatusCode.ERROR),
    services: [...new Set(spans.map((s) => s.service))],
    spans: spans.toSorted((a, b) => a.startTimeMs - b.startTimeMs),
  };
}

export function createMemoryTraceViewer(): MemoryTraceViewer {
  const traces = new Map<string, ViewableSpan[]>();
  let totalSpans = 0;

  const processor: SpanProcessor = {
    onStart() {
      /* 只在 onEnd 快照,避免持有活动对象 */
    },
    onEnd(span: ReadableSpan) {
      const snap = snapshot(span);
      const list = traces.get(snap.traceId) ?? [];
      list.push(snap);
      traces.set(snap.traceId, list);
      totalSpans += 1;
      totalSpans = evictOldTraces(traces, totalSpans);
    },
    async shutdown() {
      traces.clear();
      totalSpans = 0;
    },
    async forceFlush() {
      /* 内存缓冲无导出语义 */
    },
  };

  return {
    processor,
    recent(limit = 50) {
      const grouped: ViewableTrace[] = [];
      for (const spans of traces.values()) {
        if (spans.length === 0) continue;
        grouped.push(toViewableTrace(spans));
      }
      return grouped.toSorted((a, b) => b.startTimeMs - a.startTimeMs).slice(0, limit);
    },
    clear() {
      traces.clear();
      totalSpans = 0;
    },
  };
}
