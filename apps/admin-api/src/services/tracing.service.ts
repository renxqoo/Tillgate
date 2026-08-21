/**
 * 链路追踪服务：共享 tracing 包的 PG 读侧（recent/traces/by-request/topology/stats）。
 * SQL 归属 packages/tracing（与 trace-receiver 同一存储实现——不另造 SQL 层）。
 */
import type { Db } from '@ai-gateway/repository';
import { createPgTraceStore, type ChannelHealth, type SpanRow, type TraceStore, type TraceSummary } from '@ai-gateway/tracing';

export interface TracingServiceDeps {
  db: Db;
}

export interface TracingService {
  recent(input: {
    service?: string;
    errorsOnly?: boolean;
    minDurationMs?: number;
    requestId?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: TraceSummary[]; total: number }>;
  traceDetail(traceId: string): Promise<{ spans: SpanRow[]; services: string[]; startMs: number; durationMs: number }>;
  byRequest(requestId: string): Promise<{ spans: SpanRow[]; services: string[]; startMs: number; durationMs: number }>;
  topology(hours: number): Promise<ChannelHealth[]>;
  stats(): ReturnType<TraceStore['stats']>;
}

/** 空详情兜底（未知 traceId / requestId） */
const emptyDetail = { spans: [] as SpanRow[], services: [] as string[], startMs: 0, durationMs: 0 };

function buildDetail(spans: SpanRow[]): {
  spans: SpanRow[];
  services: string[];
  startMs: number;
  durationMs: number;
} {
  if (spans.length === 0) return emptyDetail;
  const services = [...new Set(spans.map((s) => String(s.service)))];
  const times = spans.flatMap((s) => [Number(s.startTime), Number(s.endTime)]).filter((n) => Number.isFinite(n));
  const start = Math.min(...times);
  const end = Math.max(...times);
  return { spans, services, startMs: start, durationMs: end - start };
}

export function createTracingService(deps: TracingServiceDeps): TracingService {
  const store = createPgTraceStore(deps.db);
  return {
    async recent(input) {
      const limit = Math.min(100, Math.max(1, input.limit));
      const [rows, total] = await Promise.all([
        store.findRecentTraces({
          service: input.service,
          errorsOnly: input.errorsOnly,
          minDurationMs: input.minDurationMs,
          requestId: input.requestId,
          limit,
          offset: input.offset,
        }),
        store.countRecentTraces({
          service: input.service,
          errorsOnly: input.errorsOnly,
          minDurationMs: input.minDurationMs,
          requestId: input.requestId,
        }),
      ]);
      return { rows, total };
    },

    async traceDetail(traceId) {
      return buildDetail(await store.findByTraceId(traceId));
    },

    async byRequest(requestId) {
      return buildDetail(await store.findByRequestId(requestId));
    },

    async topology(hours) {
      return store.channelTopology(Math.min(168, Math.max(1, hours)));
    },

    stats() {
      return store.stats();
    },
  };
}
