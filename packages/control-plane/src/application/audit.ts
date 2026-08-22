/**
 * 审计发射助手（v1 recordAudit 语义等价，B3）：提交后旁路 best-effort——
 * 任何失败不得阻塞已提交的业务操作。AuditSink 契约本身要求实现不抛，
 * 此处再兜一层 try/catch：实现违约也不反噬业务路径。
 */
import type { AuditEntry, AuditSink } from '../ports/audit-sink';

export async function emitAudit(audit: AuditSink, entry: AuditEntry): Promise<void> {
  try {
    await audit.record(entry);
  } catch {
    // 审计是旁路记录：静默吞掉会让「该有审计的操作实际没写进去」长期不可见——
    // 写失败的可观测性由 sink 实现负责（postgres 实现记服务端日志）。
  }
}
