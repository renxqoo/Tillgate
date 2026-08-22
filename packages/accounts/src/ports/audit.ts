/**
 * AuditPort:管理动作审计端口(v1 语义:audit_logs 仅管理面写入,C 端动作不审计;
 * MIGRATION §1.6.4)。同事务写入——失败随业务回滚,不吞(v1 audit-log.repo insert 契约);
 * 存储/查询/保留归 observability(§3.4),本包只拥有 action 与 payload 语义。
 */
import type { DbLike } from '@tokenlens/db';

export interface AuditAction {
  /** v1 词表:admin / system(系统任务;本包现行动作均为 admin) */
  readonly actor: 'admin' | 'system';
  readonly adminId: number | null;
  /** 动作动词(v1 清单:user.update / api_key.update / marketing.settings.update / referral.relation.update) */
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly detail?: Record<string, unknown> | null;
}

export interface AuditPort {
  record(db: DbLike, action: AuditAction): Promise<void>;
}
