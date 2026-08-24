/**
 * Postgres AuditSink:同事务写 audit_logs(v1 audit-log.repo insert 契约——
 * 失败随业务回滚,不吞)。存储/查询/保留归 observability(§3.4)。
 */
import { auditLogs } from '@tillgate/db';
import type { AuditPort } from '../../ports/audit.js';

export function createPostgresAuditSink(): AuditPort {
  return {
    async record(db, action) {
      await db.insert(auditLogs).values({
        adminId: action.adminId,
        actor: action.actor,
        action: action.action,
        targetType: action.targetType,
        targetId: action.targetId ?? null,
        detail: action.detail ?? null,
      });
    },
  };
}
