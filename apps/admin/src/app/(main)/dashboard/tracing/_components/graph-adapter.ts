import {
  buildTraceGraph as buildDomainGraph,
  type TraceGraph as DomainTraceGraph,
} from '@ai-gateway/tracing/graph';
import type { SpanRow } from '@ai-gateway/tracing';

export type { GraphNode } from '@ai-gateway/tracing/graph';

/**
 * admin 视图的 span 行（admin-api 返回的 JSON：时间是 ISO 字符串）。
 * 领域层 buildTraceGraph 吃 Date——这里做展示边界唯一的时间归一。
 */
export interface SpanRowLike {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  service: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  statusCode: number;
  statusMessage: string | null;
  requestId: string | null;
  channel: string | null;
  model: string | null;
  attributes: Record<string, unknown>;
}

export function buildTraceGraph(spans: SpanRowLike[]): DomainTraceGraph {
  return buildDomainGraph(
    spans.map<SpanRow>((like) => ({
      ...like,
      startTime: new Date(like.startTime),
      endTime: new Date(like.endTime),
      userId: null,
      events: [],
    })),
  );
}
