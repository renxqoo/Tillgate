/**
 * 审计 postgres 适配器：audit_logs 的写入（best-effort 语义）与价格溯源只读。
 * 写入契约（v1 recordAudit 等价，B3）：旁路 best-effort——失败记服务端日志，不抛出。
 * 存储查询保留归 observability（G3）；全局审计列表不在本包。
 */
import { and, desc, sql } from 'drizzle-orm';
import type { Db, DbLike } from '@tokenlens/db';
import { auditLogs } from '@tokenlens/db';
import type { AuditSink, AuditEntry } from '../../ports/audit-sink';
import type { AuditStore, AuditLogRow } from '../../ports/audit-store';

/** best-effort 审计写入器（旁路：写失败记日志，不阻塞已提交的业务操作） */
export function createPostgresAuditSink(db: Db): AuditSink {
  return {
    async record(entry: AuditEntry) {
      try {
        await db.insert(auditLogs).values({
          adminId: entry.adminId ?? null,
          actor: entry.actor,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId == null ? null : String(entry.targetId),
          detail: entry.detail ?? null,
        });
      } catch (error) {
        // 审计是旁路记录，不阻塞已经提交的业务操作——但静默吞掉会让「该有审计的操作
        // 实际没写进去」长期不可见；至少留下服务端日志
        console.error('[audit] write failed:', entry.action, error);
      }
    },
  };
}

export const postgresAuditStore: AuditStore = {
  async listCatalogPriceHistory(db: DbLike, input): Promise<readonly AuditLogRow[]> {
    // 目录定价溯源：action ∈ {import, import_draft} 且 detail.models 含该对外名（jsonb containment）
    return db
      .select()
      .from(auditLogs)
      .where(
        and(
          sql`${auditLogs.action} in ('model_catalog.import', 'model_catalog.import_draft')`,
          sql`${auditLogs.detail} -> 'models' @> ${JSON.stringify([{ externalName: input.externalName }])}::jsonb`,
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(input.limit ?? 50) as Promise<AuditLogRow[]>;
  },
};
