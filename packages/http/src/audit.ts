import type { Db } from '@ai-gateway/db';
import { auditLogs } from '@ai-gateway/db/schema';

/**
 * 审计日志组件（data-model §3.14，audit_logs 表）。
 *
 * actor 语义：
 *   - admin：管理员手动操作（adminId 对应 admins.id）
 *   - user：用户自助操作（client-api，adminId 为 NULL）
 *   - system：系统任务（对账/赠送/自动冻结，adminId 为 NULL）
 *
 * 审计是旁路记录：写失败只吞掉，不阻塞已经提交的业务操作。
 */

export type AuditActor = 'admin' | 'user' | 'system';

export interface AuditInput {
  actor: AuditActor;
  action: string;
  targetType: string;
  targetId?: string | number | null;
  detail?: Record<string, unknown> | null;
  adminId?: number | null;
}

export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      adminId: input.adminId ?? null,
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId == null ? null : String(input.targetId),
      detail: input.detail ?? null,
    });
  } catch {
    // 审计是旁路记录，不阻塞已经提交的业务操作。
  }
}
