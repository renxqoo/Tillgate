/** span 落库行（与 trace_spans 列对齐；createdAt 由 DB 默认值生成） */
export interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  service: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  /** OTel StatusCode：0=UNSET 1=OK 2=ERROR */
  statusCode: number;
  statusMessage: string | null;
  /** 领域提升列（来自 OTel attributes，供计费关联点查） */
  requestId: string | null;
  userId: number | null;
  channel: string | null;
  model: string | null;
  /** 完整 span 属性（归一化后的原始键值） */
  attributes: Record<string, unknown>;
  events: Array<{ name: string; timeMs: number; attributes?: Record<string, unknown> }>;
}

/** trace 摘要（admin 列表用） */
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
  /** 只看该服务（省略 = 全部） */
  service?: string;
  /** 只看含 ERROR span 的 trace */
  errorsOnly?: boolean;
  /** 根时长下限（毫秒） */
  minDurationMs?: number;
  /** 按 requestId 精确过滤（计费复核页关联入口） */
  requestId?: string;
  limit?: number;
  /** 分页游标：上一页最后一条的 startTimeMs */
  beforeMs?: number;
}

export interface TraceStore {
  /** 批量写入（幂等：主键冲突忽略；自动确保目标日分区存在） */
  writeBatch(rows: SpanRow[]): Promise<number>;
  findRecentTraces(filter: RecentFilter): Promise<TraceSummary[]>;
  findByTraceId(traceId: string): Promise<SpanRow[]>;
  findByRequestId(requestId: string): Promise<SpanRow[]>;
  stats(): Promise<{ spans: number; oldestDays: number | null; partitions: string[] }>;
}
