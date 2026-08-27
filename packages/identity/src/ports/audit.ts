/**
 * 审计发射 port(事务参与形态):record(db, event) 在业务事务提交前
 * 于同一事务内写入——回滚即无审计行,提交即落库,不存在「审计先于提交」的幻事件,
 * 也不降级为提交后 best-effort(安全审计不吞错:record 失败随业务事务回滚)。
 * 持久化实现由装配提供(observability writeAudit / admin-api 侧 sink)。
 */
import type { DbLike } from '@tillgate/db';
import type { IdentityAuditEvent } from '../domain/audit-events.js';

export interface AuditPort {
  /** db 传业务事务的 tx 时随事务原子;传独立连接时为单写(失败抛错,不吞) */
  record(db: DbLike, event: IdentityAuditEvent): Promise<void>;
}
