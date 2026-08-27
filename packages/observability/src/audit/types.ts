/**
 * 审计词表:audit_logs 的写入原语与通用查询形态(存储/查询/保留归本包;
 * audit action 与 payload 语义归各业务能力,经其自有 port 发出,由 apps assembly 桥接本包原语)。
 *
 * 写入双语义:
 *   - writeAudit:同事务参与——失败随业务事务回滚,不吞(资金/安全/权限审计);
 *   - createBestEffortAuditSink(adapters):提交后旁路——不抛、失败记日志(低价值运营审计)。
 */
import type { DbLike } from '@tillgate/db';

/** actor 语义:admin=管理员手动操作;user=用户自助;system=系统任务(对账/赠送/自动冻结) */
export type AuditActor = 'admin' | 'user' | 'system';

export interface AuditEntry {
  readonly actor: AuditActor;
  /** admin 动作对应 admins.id;user/system 为 null */
  readonly adminId?: number | null;
  /** 动作动词(词表所有者 = 发起审计的业务能力,如 channel.update) */
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | number | null;
  /** 变更前后摘要 */
  readonly detail?: Record<string, unknown> | null;
}

/** 同事务审计写入(在调用方事务连接上执行;失败抛出 = 随业务回滚) */
export type WriteAudit = (db: DbLike, entry: AuditEntry) => Promise<void>;

export interface AuditLogRow {
  readonly id: number;
  readonly adminId: number | null;
  readonly actor: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly detail: unknown;
  readonly createdAt: Date;
}

export interface AuditListInput {
  /** q 命中 action/targetType/targetId(ilike) */
  q?: string;
  sortBy: 'id' | 'action' | 'createdAt';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface AuditListByTargetInput {
  targetType: string;
  targetId: string;
  limit: number;
  offset: number;
}

/** 审计通用查询面(管理审计页 / 复核下钻);价格溯源等 action 语义查询归能力包(control-plane) */
export interface AuditQueries {
  list(input: AuditListInput): Promise<{ rows: AuditLogRow[]; total: number }>;
  listByTarget(input: AuditListByTargetInput): Promise<AuditLogRow[]>;
}
