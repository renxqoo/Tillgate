import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { Db, DbLike } from '@tillgate/db';
import { auditLogs } from '@tillgate/db';
import type {
  AuditEntry,
  AuditListInput,
  AuditListByTargetInput,
  AuditQueries,
  AuditLogRow,
} from '../../audit/types';
import { escapeLikePattern } from './search';

/**
 * audit_logs 的 PG 适配:写入双原语(G1)+ 通用查询面。
 * 写入契约:
 *   - writeAudit 在调用方事务连接上执行,失败抛出 = 随业务回滚,不吞(资金关键操作);
 *   - createBestEffortAuditSink 提交后旁路,不抛、失败记日志(B3:log 可注入,缺省 console.error)。
 */

/** 事务内审计写入(资金关键操作——失败即随业务回滚,不吞) */
export async function writeAudit(db: DbLike, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    adminId: entry.adminId ?? null,
    actor: entry.actor,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId == null ? null : String(entry.targetId),
    detail: entry.detail ?? null,
  });
}

export interface BestEffortAuditSink {
  /** best-effort 记录(契约:不抛) */
  record(entry: AuditEntry): Promise<void>;
}

export function createBestEffortAuditSink(
  db: Db,
  log: (obj: unknown, msg: string) => void = (obj, msg) => console.error(msg, obj),
): BestEffortAuditSink {
  return {
    async record(entry) {
      try {
        await writeAudit(db, entry);
      } catch (error) {
        // 审计是旁路记录,不阻塞已经提交的业务操作——但静默吞掉会让「该有审计的操作
        // 实际没写进去」长期不可见;至少留下服务端日志
        log({ action: entry.action, error }, '[audit] write failed:');
      }
    },
  };
}

const listColumns = {
  id: auditLogs.id,
  adminId: auditLogs.adminId,
  actor: auditLogs.actor,
  action: auditLogs.action,
  targetType: auditLogs.targetType,
  targetId: auditLogs.targetId,
  detail: auditLogs.detail,
  createdAt: auditLogs.createdAt,
};

/** 全局审计列表:q 命中 action/targetType/targetId */
export function createPgAuditQueries(db: Db): AuditQueries {
  return {
    async list(input: AuditListInput) {
      const where = input.q
        ? or(
            ilike(auditLogs.action, escapeLikePattern(input.q)),
            ilike(auditLogs.targetType, escapeLikePattern(input.q)),
            ilike(auditLogs.targetId, escapeLikePattern(input.q)),
          )
        : undefined;
      const sorts = {
        id: auditLogs.id,
        action: auditLogs.action,
        createdAt: auditLogs.createdAt,
      } as const;
      const column = sorts[input.sortBy];
      const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(auditLogs.id)];
      const [rows, countRows] = await Promise.all([
        db
          .select(listColumns)
          .from(auditLogs)
          .where(where)
          .orderBy(...orderBy)
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogs)
          .where(where),
      ]);
      return { rows: rows as AuditLogRow[], total: countRows[0]?.count ?? 0 };
    },

    /** 定向审计查询(复核下钻:targetType+targetId) */
    async listByTarget(input: AuditListByTargetInput) {
      const rows = await db
        .select(listColumns)
        .from(auditLogs)
        .where(
          and(eq(auditLogs.targetType, input.targetType), eq(auditLogs.targetId, input.targetId)),
        )
        .orderBy(desc(auditLogs.id))
        .limit(input.limit)
        .offset(input.offset);
      return rows as AuditLogRow[];
    },
  };
}
