/**
 * @tillgate/observability 公共出口:可观测能力(OTel 装配、链路追踪、审计存储查询、请求日志)。
 * 出口面刻意极小且由 __test__/architecture.test.ts 快照锁定——adapters/适配器/drizzle 行类型
 * 不出包;SQL 只在 adapters/postgres,OTel SDK 只在 telemetry(架构测试强制)。
 */

// ---- facade ----
export { createObservability } from './observability';
export type { Observability, ObservabilityEnv } from './observability';

// ---- 错误目录(码表封闭性由架构测试锁定)----
export { observabilityErrors } from './errors';

// ---- telemetry(OTel 装配;零 DB)----
export { initOtel } from './telemetry/init-otel';
export type { OtelMode, InitOtelOptions, OtelHandle } from './telemetry/init-otel';
export { createMemoryTraceViewer } from './telemetry/memory-viewer';
export type { MemoryTraceViewer, ViewableSpan, ViewableTrace } from './telemetry/memory-viewer';
export { createLogSpanProcessor } from './telemetry/log-span-processor';
export type { SpanLogSink } from './telemetry/log-span-processor';
export { formatTraceParent, remoteParentContext } from './telemetry/trace-parent';
export { withAsyncSpan } from './telemetry/with-span';
export {
  trace,
  metrics,
  context,
  SpanStatusCode,
  getTracer,
  getMeter,
  type Tracer,
  type Span,
  type Meter,
  type Context,
  type SpanContext,
} from './telemetry/api';

// ---- tracing:纯逻辑 ----
export { decodeOtlpJson } from './tracing/decode';
export type { DecodeResult } from './tracing/decode';
export { buildTraceGraph } from './tracing/graph';
export type {
  TraceGraph,
  GraphNode,
  GraphEdge,
  GraphNodeKind,
  GraphNodeStatus,
} from './tracing/graph';
export { dayKey, shiftDay } from './tracing/partition';
export type { MaintainPartitionsOptions, MaintainPartitionsResult } from './tracing/partition';

// ---- tracing:port 与词表 ----
export type {
  SpanRow,
  TraceSummary,
  RecentFilter,
  ChannelHealth,
  TraceStore,
  TraceStoreStats,
} from './tracing/types';
export { createSpanBatcher } from './tracing/ingest';
export type { SpanBatcher, SpanBatcherOptions, BatcherStats } from './tracing/ingest';
export { createTraceQueries } from './tracing/queries';
export type { TraceQueries, TraceDetail } from './tracing/queries';

// ---- audit:词表与写入原语(同事务审计的事务边界归调用方)----
export type {
  AuditActor,
  AuditEntry,
  AuditLogRow,
  AuditListInput,
  AuditListByTargetInput,
  AuditQueries,
} from './audit/types';

// ---- request-log:词表 ----
export type {
  RequestLogWriteInput,
  RequestLogListInput,
  RequestLogRow,
  RequestLogStore,
} from './request-log/types';

// ---- usage:运维读侧词表(usage_logs 表归 billing 结算投影,此处只承载查询)----
export { USAGE_SORT_FIELDS } from './usage/types';
export type {
  UsageSortField,
  UsageGroupAxis,
  UsageAdminListInput,
  UsageAdminRow,
  UsageGroupRow,
  UsageTrendRow,
  ChannelTtftRow,
  ChannelStatusCount,
  UsageStatsStore,
} from './usage/types';
export { createUsageQueries } from './usage/queries';
export type { UsageQueries } from './usage/queries';
export { BEIJING_ZONE_OFFSET_MS, beijingDayStart, beijingTrendsFrom } from './usage/day-window';
