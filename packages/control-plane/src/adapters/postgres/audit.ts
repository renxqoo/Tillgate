/**
 * 审计 postgres 适配器：audit_logs 的事务参与写入、best-effort 写入与价格溯源只读。
 * 两个写入形态（§5.4 / G3）：
 * - **postgresAuditTxSink（事务参与）**：随业务事务写 audit_logs——失败抛错回滚，
 *   资金/安全类审计（channel.recharge/adjust、rate_card.update）的强制形态；
 * - **createPostgresAuditSink（best-effort）**：仅低价值运营事件（建档/改档/fx/导入），
 *   失败记服务端日志不阻塞已提交业务（降级清单见 ports/audit-sink.ts 文件头）。
 * 存储查询保留归 observability（G3）；全局审计列表不在本包。
 */
import { and, desc, sql } from 'drizzle-orm';
import type { Db, DbLike } from '@tokenlens/db';
import { auditLogs } from '@tokenlens/db';
import type { AuditSink, AuditTxSink, AuditEntry } from '../../ports/audit-sink';
import type { AuditStore, AuditLogRow } from '../../ports/audit-store';

/** 事务参与审计写入器（§5.4：与业务同事务——失败抛错随事务回滚，不吞错） */
export const postgresAuditTxSink: AuditTxSink = {
  async recordWithinTx(db: DbLike, entry: AuditEntry): Promise<void> {
    await db.insert(auditLogs).values({
      adminId: entry.adminId ?? null,
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId == null ? null : String(entry.targetId),
      detail: entry.detail ?? null,
    });
  },
};

/** best-effort 审计写入器（仅低价值运营事件；写失败记日志，不阻塞已提交的业务操作） */
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
        // 降级路径（G3 清单内运营事件）：静默吞掉会让「该有审计的操作实际没写进去」
        // 长期不可见——至少留下服务端日志；资金/安全类审计禁用本形态
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
