/**
 * 审计发射 port:观察事实单向出口(持久化归 observability/admin-api 装配)。
 * 事件仅在本包事务提交后发射(B03);record 自身的失败由 application 捕获降级 warn。
 */
import type { IdentityAuditEvent } from '../domain/audit-events.js';

export interface AuditPort {
  record(event: IdentityAuditEvent): Promise<void>;
}
