/**
 * 死信复核共享契约：命令守卫与审计 port。
 * 审计口径：复核是资金敏感操作——审计与业务同事务，
 * port 由 app 装配桥接 observability writeAudit；缺省丢弃（测试缝）。
 */
import { BillingErrors } from '../../../domain/errors.js';
import type { WalletTx } from '../../../ports/wallet-store.js';

export interface ReviewCommand {
  requestId: string;
  /** 乐观锁：与账单行 revision 不符 → state_conflict（并发复核双守卫） */
  expectedRevision: number;
  reason: string;
  evidenceRefs?: readonly string[];
}

export interface ReviewAuditEntry {
  actor: 'admin';
  adminId: number;
  action: 'billing.retry_dead' | 'billing.abandon_dead';
  targetType: 'billing_request';
  targetId: string;
  detail: Record<string, unknown>;
}

export type ReviewAuditTx = (tx: WalletTx, entry: ReviewAuditEntry) => Promise<void>;

export function assertReviewCommand(command: ReviewCommand): void {
  const reason = command.reason.trim();
  if (reason.length === 0 || reason.length > 1000) {
    throw BillingErrors.business('invalid_review_command', { field: 'reason' });
  }
  if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) {
    throw BillingErrors.business('invalid_review_command', { field: 'expectedRevision' });
  }
}
