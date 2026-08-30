/**
 * 请求日志词表:request_logs 的写入与查询形态。
 * 与 usage_logs 分工:本表为排障日志(观测,best-effort 不反压请求路径);
 * usage_logs 是计费账本投影,归 billing。
 */

export interface RequestLogWriteInput {
  requestId: string;
  userId: number | null;
  apiKeyId: number | null;
  method: string;
  path: string;
  statusCode: number;
  errorCode: string | null;
  durationMs: number;
  /** 截断后的请求摘要(model/stream/max_tokens——不含敏感内容);嗅探逻辑在 gateway 中间件 */
  requestSummary: Record<string, unknown> | null;
  /** 真实上游尝试次数(换渠/同渠道重试均计;缺省 1——非推理路由) */
  attempts?: number;
  /** 来源 IP(鉴权前记录——401/429 也入日志;「记录一切 /v1 请求」语义) */
  sourceIp: string | null;
}

export interface RequestLogListInput {
  q?: string;
  from?: Date;
  to?: Date;
  userId?: number;
  /** 数值状态码或 '2xx'/'4xx'/'5xx' 分组 */
  statusCode?: number | '2xx' | '4xx' | '5xx';
  sortBy: 'id' | 'statusCode' | 'durationMs' | 'createdAt';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
  now: Date;
}

export interface RequestLogRow {
  readonly id: number;
  readonly requestId: string;
  readonly userId: number | null;
  /** 来源用户展示名(users.displayName 兜底 email;未关联用户为 null) */
  readonly userName: string | null;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly errorCode: string | null;
  readonly sourceIp: string | null;
  readonly durationMs: number;
  readonly requestSummary: Record<string, unknown> | null;
  readonly createdAt: Date;
}

/**
 * 请求日志存储:写入 best-effort 由调用方(gateway 中间件)兜住;查询缺省 30 天窗
 * (与保留期对齐,见 adapters/postgres/request-log-partitions)。
 */
export interface RequestLogStore {
  insert(input: RequestLogWriteInput): Promise<void>;
  list(input: RequestLogListInput): Promise<{ rows: RequestLogRow[]; total: number }>;
}
