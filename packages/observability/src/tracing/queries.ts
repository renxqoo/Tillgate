import type { ChannelHealth, SpanRow, TraceStore, TraceStoreStats, TraceSummary } from './types';

/**
 * trace 查询信封:
 * 钳位、rows+total 并行、详情组装。SQL/聚合在 TraceStore(唯一实现归 adapters);
 * 本层只做口径与信封——参数守卫(regex 白名单)在存储侧(防注入)。
 */

export interface TraceDetail {
  spans: SpanRow[];
  services: string[];
  startMs: number;
  durationMs: number;
}

export interface TraceQueries {
  recent(input: {
    service?: string;
    errorsOnly?: boolean;
    minDurationMs?: number;
    requestId?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: TraceSummary[]; total: number }>;
  traceDetail(traceId: string): Promise<TraceDetail>;
  byRequest(requestId: string): Promise<TraceDetail>;
  topology(hours: number): Promise<ChannelHealth[]>;
  stats(): Promise<TraceStoreStats>;
}

/** 空详情兜底(未知 traceId / requestId) */
const emptyDetail: TraceDetail = { spans: [], services: [], startMs: 0, durationMs: 0 };

function buildDetail(spans: SpanRow[]): TraceDetail {
  if (spans.length === 0) return emptyDetail;
  const services = [...new Set(spans.map((s) => String(s.service)))];
  const times = spans
    .flatMap((s) => [Number(s.startTime), Number(s.endTime)])
    .filter((n) => Number.isFinite(n));
  const start = Math.min(...times);
  const end = Math.max(...times);
  return { spans, services, startMs: start, durationMs: end - start };
}

export function createTraceQueries(store: TraceStore): TraceQueries {
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
      return store.channelTopology(Date.now() - Math.min(168, Math.max(1, hours)) * 3_600_000);
    },

    stats() {
      return store.stats();
    },
  };
}
