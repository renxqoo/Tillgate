/**
 * identity 审计桥:IdentityAuditEvent →
 * observability writeAudit 行。actor 形如 'admin:7'/'system'——adminId 数值化,
 * 未知形态降级 null（审计行不断流）。action 加 'identity.' 前缀入 audit_logs
 * 命名空间（与 accounts/control-plane 桥同口径）。装配面文件:仅 assembly 引用。
 */
import type { AuditPort, IdentityAuditEvent } from '@tillgate/identity';
import type { DbLike } from '@tillgate/db';

/** writeAudit 的最小结构子集（observability/composition 同形状;避免 app 持包内类型） */
export type WriteAuditFn = (
  db: DbLike,
  entry: {
    actor: 'admin' | 'user' | 'system';
    adminId: number | null;
    action: string;
    targetType: string;
    targetId: string | number;
    detail?: Record<string, unknown>;
  },
) => Promise<void>;

function adminIdOf(actor: string): number | null {
  const m = /^admin:(\d+)$/.exec(actor);
  return m != null ? Number(m[1]) : null;
}

export function createIdentityAuditSinkBridge(writeAudit: WriteAuditFn): AuditPort {
  return {
    record: (db: DbLike, event: IdentityAuditEvent) =>
      writeAudit(db, {
        // actor 词表映射：identity 'admin:N' → 'admin';其余（'system'/未知）→ 'system'
        //（审计行不断流,降级保守——数值归属已在 adminId 列）
        actor: event.actor.startsWith('admin') ? 'admin' : 'system',
        adminId: adminIdOf(event.actor),
        action: `identity.${event.action}`,
        targetType: event.targetType,
        targetId: event.targetId,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      }),
  };
}
