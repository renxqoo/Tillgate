/**
 * tracing 词表与存储 port。
 * SQL 归 adapters/postgres/trace-store;本文件只有纯类型与 port 契约。
 */

/** span 落库行(与 trace_spans 列对齐;createdAt 由 DB 默认值生成) */
export interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  service: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  /** OTel StatusCode:0=UNSET 1=OK 2=ERROR */
  statusCode: number;
  statusMessage: string | null;
  /** 领域提升列(来自 OTel attributes,供计费关联点查) */
  requestId: string | null;
  userId: number | null;
  channel: string | null;
  model: string | null;
  /** 完整 span 属性(归一化后的原始键值) */
  attributes: Record<string, unknown>;
  events: Array<{ name: string; timeMs: number; attributes?: Record<string, unknown> }>;
}

/** trace 摘要(管理列表用) */
export interface TraceSummary {
  traceId: string;
  rootName: string;
  startTimeMs: number;
  durationMs: number;
  spanCount: number;
  hasError: boolean;
  services: string[];
  requestId: string | null;
}

export interface RecentFilter {
  /** 只看该服务(省略 = 全部) */
  service?: string;
  /** 只看含 ERROR span 的 trace(trace 级语义:ERROR span 的 trace 全量保留) */
  errorsOnly?: boolean;
  /** 根时长下限(毫秒) */
  minDurationMs?: number;
  /** 按 requestId 精确过滤(计费复核页关联入口) */
  requestId?: string;
  limit?: number;
  /** 分页偏移(page/page_size 语义) */
  offset?: number;
}

/** 渠道健康聚合(24h 窗口,来自 gateway upstream spans) */
export interface ChannelHealth {
  channel: string;
  attempts: number;
  errors: number;
  avgDurationMs: number;
  lastAt: number | null;
  lastError: string | null;
}

export interface TraceStoreStats {
  spans: number;
  oldestDays: number | null;
  partitions: string[];
}

/**
 * trace 存储 port。写入幂等(主键冲突忽略)+ 自动确保目标日分区;
 * 数据等级:诊断数据 best-effort——写入失败由调用方(接收端 batcher)丢弃并计数,绝不反压。
 */
export interface TraceStore {
  /** 批量写入(幂等:主键冲突忽略;自动确保目标日分区存在) */
  writeBatch(rows: SpanRow[]): Promise<number>;
  findRecentTraces(filter: RecentFilter): Promise<TraceSummary[]>;
  /** 最近 trace 总数(与 findRecentTraces 同过滤条件,分页 total) */
  countRecentTraces(filter: Omit<RecentFilter, 'limit' | 'offset'>): Promise<number>;
  findByTraceId(traceId: string): Promise<SpanRow[]>;
  findByRequestId(requestId: string): Promise<SpanRow[]>;
  stats(): Promise<TraceStoreStats>;
  /** 渠道健康拓扑(网关 → 各渠道的尝试/错误/延迟聚合) */
  channelTopology(sinceMs: number): Promise<ChannelHealth[]>;
}
