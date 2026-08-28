/**
 * 审计发射助手：
 * - emitAuditWithinTx：资金/安全类审计与业务同事务写入——写入失败抛错随业务事务
 *   回滚（审计与业务变更原子：要么都落、要么都不落）；
 * - emitAudit：低价值运营事件的提交后 best-effort 降级路径（显式策略非默认，
 *   降级清单见 ports/audit-sink.ts 文件头）——失败记上下文日志不阻塞已提交业务。
 */
import type { DbLike } from '@tillgate/db';
import type { AuditEntry, AuditSink, AuditTxSink } from '../ports/audit-sink';

/** 事务参与发射：不吞错——失败随调用方事务回滚 */
export function emitAuditWithinTx(
  audit: AuditTxSink,
  db: DbLike,
  entry: AuditEntry,
): Promise<void> {
  return audit.recordWithinTx(db, entry);
}

/** best-effort 发射（仅降级清单内低价值运营事件）：失败不反噬已提交业务 */
export async function emitAudit(audit: AuditSink, entry: AuditEntry): Promise<void> {
  try {
    await audit.record(entry);
  } catch (error) {
    // 降级路径的可观测性由 sink 实现负责（postgres 实现记服务端日志）；
    // 此处再兜一层 try/catch：实现违约（抛出）也不反噬业务路径
    void error;
  }
}
