/** 幂等操作内核契约类型（对外唯一形状；实现文件只引用此处，不重复定义） */
import type { DbLike, Tx } from './internal.js';

/** 回执：任意 JSON 安全数据（canonical 可序列化；大小 ≤16KB） */
export type OperationReceipt = Record<string, unknown>;

export interface LedgerEffects {
  /** 提交后触发（含重放，replayed 区分）：缓存失效/事件广播等出站效应 */
  committed?(event: {
    operationId: string;
    kind: string;
    replayed: boolean;
    receipt: OperationReceipt | null;
  }): Promise<void>;
  /** 尽力而为审计（提交后观测失败不改变已提交结果，包内吞掉） */
  audit?(event: {
    actor?: 'user' | 'admin' | 'system';
    action: string;
    targetType: string;
    targetId?: string | number | null;
    detail?: Record<string, unknown> | null;
  }): Promise<void>;
}

/** 必填白名单（fail-closed，对齐 wallet/identity-core 三白名单） */
export interface CreateLedgerOptions {
  /** 允许的操作类型（snake/kebab 小写词表；空数组=拒绝一切 run） */
  kinds: readonly string[];
  effects?: LedgerEffects;
}

export interface RunOperationInput<T extends OperationReceipt | null = OperationReceipt | null> {
  /** 全局唯一幂等键（调用方设计责任；推荐 'domain.subject:业务键'） */
  operationId: string;
  kind: string;
  /** 参与指纹的业务参数（canonical 哈希——同键不同参重放=OperationConflictError） */
  fingerprint: unknown;
  /**
   * 业务执行体：事务内做「业务状态机写 + 钱动词（wallet 的 tx 注入）」并返回回执。
   * 抛错 → 整个事务（含操作行）回滚，可安全重试；回执写入前经 canonical/大小校验。
   */
  execute: (tx: Tx) => Promise<T>;
  /** 参与调用方事务时传入（与调用方业务写同生共死）；不传则包内自开事务 */
  tx?: DbLike;
}

export interface RunOperationResult<T extends OperationReceipt | null = OperationReceipt | null> {
  operationId: string;
  kind: string;
  /** 首次执行=execute 返回值；重放=首次的存档回执（逐字节一致） */
  receipt: T;
  /** true = 幂等重放，execute 未执行 */
  replayed: boolean;
  createdAt: string;
}

export interface OperationView {
  operationId: string;
  kind: string;
  fingerprint: string;
  receipt: OperationReceipt | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListOperationsInput {
  kind?: string;
  /** 1-200，默认 50 */
  limit?: number;
  /** 上一页 nextCursor（不透明） */
  cursor?: string;
}

export interface ListOperationsResult {
  items: OperationView[];
  nextCursor: string | null;
}

export interface Ledger {
  /** 幂等执行：并发/重试/重放下同键至多一次 execute；指纹漂移=冲突（409 语义） */
  run<T extends OperationReceipt | null>(input: RunOperationInput<T>): Promise<RunOperationResult<T>>;
  /** 单条查询（管理端/对账用）；不存在返回 null */
  operation(input: { operationId: string }): Promise<OperationView | null>;
  /** 游标分页列表（id 倒序；kind 过滤）——管理端操作流水读侧 */
  operations(input?: ListOperationsInput): Promise<ListOperationsResult>;
}
