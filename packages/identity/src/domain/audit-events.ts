/**
 * 审计事件词表与构造(封闭;持久化归 observability,本包经 AuditPort 发射)。
 * 发射时机契约(B03 修复):自有事务用例在提交后发射;composition bridge 的
 * 事件由调用方事务提交后冲洗。事件是观察事实,不承载资金/安全最终性。
 */
export const AUDIT_ACTIONS = [
  'credential.register',
  'credential.replay',
  'credential.authenticate',
  'password.change',
  'password.reset',
  'challenge.begin',
  'challenge.verify',
  'challenge.abort',
  'oauth.link',
  'oauth.unlink',
  'mfa.enroll',
  'mfa.confirm',
  'mfa.disable',
  'session.revoke',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface IdentityAuditEvent {
  readonly action: AuditAction;
  readonly at: string;
  readonly actor: string;
  readonly targetType: string;
  readonly targetId: string | number;
  readonly detail?: Record<string, unknown>;
}

export function auditEvent(now: Date, input: Omit<IdentityAuditEvent, 'at'>): IdentityAuditEvent {
  return { ...input, at: now.toISOString() };
}
