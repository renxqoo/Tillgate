import type { GenerationTaskKind } from '../domain/generation';
import type { UsageReceipt } from '../domain/usage/receipt';

/** 任务状态词表(DB check 约束同源;wire zod/管理过滤的单一真相) */
export const GENERATION_TASK_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'expired',
] as const;
export type GenerationTaskStatus = (typeof GENERATION_TASK_STATUSES)[number];
/**
 * 生成任务存储 port（消费方定义；生产实现为 postgres（generation_tasks 表，
 * 经 control-plane/db 装配），单副本/测试用内存适配器）。
 * 轮询推进用例（application/generation-poll.ts，worker app 驱动）消费本 port 的
 * 推进动词族；入队适配面只写 insert——状态机 UPDATE 全部在推进动词内
 * （单一写口径，避免双写漂移）。
 */

export interface GenerationTaskRecord {
  taskId: string;
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  /** 命中候选的映射 id（收据模板快照同源） */
  mappingId: number;
  channelId: number | null;
  kind: GenerationTaskKind;
  /** 上游任务号（task_execute = null；task_poll 同步完成 = null） */
  upstreamTaskId: string | null;
  /** 出站模型名快照（提交时绑定行物化；worker 代执行构造请求用） */
  upstreamModel: string;
  status: 'queued';
  /** 提交参数快照（descriptor.snapshotParams 白名单产物） */
  params: Record<string, unknown>;
  /** 结算收据模板（除 units 外完整；轮询终态时补 units 快照结算） */
  receiptTemplate: UsageReceipt;
  /** 计量快照（提交时点按 pricingUnit 计量） */
  unitsSnapshot: number;
  /** 过期时刻（epoch ms；过期回收归 worker） */
  expiresAt: number;
}

export interface GenerationTaskView {
  taskId: string;
  kind: GenerationTaskKind;
  status: GenerationTaskStatus;
  /** 上游任务号（task_execute / 同步完成 = null） */
  upstreamTaskId: string | null;
  params: Record<string, unknown>;
  result: unknown;
  failReason: string | null;
  createdAt: number;
  expiresAt: number;
}

/** 轮询推进行（上游查询与代执行所需的全部快照；epoch ms 时间戳） */
export interface GenerationTaskActiveRow {
  taskId: string;
  requestId: string;
  channelId: number;
  kind: GenerationTaskKind;
  status: 'queued' | 'running';
  upstreamTaskId: string | null;
  /** 出站模型名快照（提交时绑定行物化；代执行请求构造用） */
  upstreamModel: string;
  params: Record<string, unknown>;
  receiptTemplate: UsageReceipt;
  unitsSnapshot: number;
  createdAt: number;
  expiresAt: number;
}

/** 管理任务列表行(账单状态经 billing_requests 左联——无账单行 null) */
export interface GenerationTaskAdminRow {
  taskId: string;
  /** 账单锚(billing_requests.request_id;实扣金额回填的关联键) */
  requestId: string;
  kind: GenerationTaskKind;
  status: GenerationTaskStatus;
  userId: number;
  channelId: number;
  upstreamTaskId: string | null;
  failReason: string | null;
  result: Record<string, unknown> | null;
  /** 账单状态(billing_requests.status;null = 无账单行) */
  billingStatus: string | null;
  createdAt: number;
  finishedAt: number | null;
  expiresAt: number;
}

/** 管理列表输入(kind/status 过滤 + limit/offset 运维翻页;createdAt 降序) */
export interface GenerationTaskAdminListInput {
  kind?: GenerationTaskKind;
  status?: GenerationTaskStatus;
  limit: number;
  offset: number;
}

export interface GenerationTaskStore {
  insert(record: GenerationTaskRecord): Promise<void>;
  /** 属主隔离查询：非本人/不存在一律 null（404 语义） */
  findByOwner(userId: number, taskId: string): Promise<GenerationTaskView | null>;
  /** 管理面全量列表（kind/status 过滤 + total 全量） */
  adminList(
    input: GenerationTaskAdminListInput,
  ): Promise<{ rows: GenerationTaskAdminRow[]; total: number }>;
  /**
   * 已结算任务的实扣金额（页内批量——消除 N+1）:taskId → usage_logs.amount。
   * 关联走 generation_tasks.request_id = usage_logs.request_id（账单锚;
   * 任务主键与计费 requestId 分立,按 request_id join）。
   */
  settledAmounts(taskIds: readonly string[]): Promise<Map<string, string>>;

  // ---- 轮询推进（worker 驱动；SQL/UPDATE 只在 adapters） ----

  /**
   * 超时扫描：queued/running 且 expires_at ≤ 存储端权威时钟 → CAS expired
   * （fail_reason = reason）；返回行供调用方发释放信号。
   */
  expireOverdue(reason: string): Promise<Array<{ taskId: string; requestId: string }>>;
  /**
   * 活跃任务分页（kinds × statuses 过滤，createdAt 升序 + 游标——首屏饥饿防线：
   * 防头部热点反复占据批位）。
   */
  listActive(input: {
    kinds: readonly GenerationTaskKind[];
    statuses: readonly ('queued' | 'running')[];
    batch: number;
    afterCreatedAt?: number;
  }): Promise<GenerationTaskActiveRow[]>;
  /** queued → running（0/1 行迁移；无 CAS 竞争——他副本迁移同效） */
  markRunning(taskId: string): Promise<boolean>;
  /**
   * 终态 CAS（0 行 = 他副本已终态化）：succeeded 必带 result；
   * failed/expired 必带 failReason（DB 终态一致性 CHECK 同源）。
   */
  casTerminal(
    input:
      | { taskId: string; status: 'succeeded'; result: Record<string, unknown> }
      | { taskId: string; status: 'failed' | 'expired'; failReason: string },
  ): Promise<boolean>;
}
