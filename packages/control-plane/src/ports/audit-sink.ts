/**
 * 审计出口 port：control-plane 拥有 audit action 与 payload 语义，经此发出；
 * 存储与查询归 observability（总纲 §3.4）——落地前由 adapters/postgres 承接。
 *
 * 语义契约（v1 recordAudit 等价，B3）：提交后旁路 best-effort——实现**不得抛出**，
 * 写失败记服务端日志，绝不阻塞已提交的业务操作。
 * 升格为事务参与 port（资金审计同事务）挂账 observability 波次（IMPLEMENTATION §6 G3）。
 */

export type AuditActor = 'admin' | 'user' | 'system';

export interface AuditEntry {
  readonly actor: AuditActor;
  readonly adminId?: number | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | number | null;
  readonly detail?: Record<string, unknown> | null;
}

export interface AuditSink {
  /** best-effort 记录（契约：不抛） */
  record(entry: AuditEntry): Promise<void>;
}
