/**
 * 审计出口 port：control-plane 拥有 audit action 与 payload 语义，经此发出；
 * 存储与查询归 observability（总纲 §3.4）——落地前由 adapters/postgres 承接。
 *
 * 两个形态（§5.4 / G3 核销）：
 * - **AuditTxSink（事务参与 port，资金/安全类审计强制形态）**：签名带 DbLike，
 *   写入与业务状态同事务——失败抛错随业务事务回滚，审计与业务变更原子
 *   （要么都落、要么都不落）。渠道进货/调账、费率卡变更走此形态。
 * - **AuditSink（提交后 best-effort，显式降级）**：仅限低价值运营事件
 *   （provider/model 建档改档、fx 配置、目录导入审计）——丢失可接受、不阻塞
 *   已提交业务；降级清单见 IMPLEMENTATION.md §6 G3。
 */

import type { DbLike } from '@tokenlens/db';

export type AuditActor = 'admin' | 'user' | 'system';

export interface AuditEntry {
  readonly actor: AuditActor;
  readonly adminId?: number | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | number | null;
  readonly detail?: Record<string, unknown> | null;
}

/** 事务参与审计 port（§5.4：写入失败抛错，随调用方业务事务回滚） */
export interface AuditTxSink {
  recordWithinTx(db: DbLike, entry: AuditEntry): Promise<void>;
}

/** best-effort 审计出口（契约：不抛；仅低价值运营事件使用——见文件头降级清单） */
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}
