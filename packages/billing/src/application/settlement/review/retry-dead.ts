/**
 * 死信重试：CAS dead→retry_wait（revision 乐观锁 + 清失败态/重置退避）。
 * 幂等：operations 档案（同键同参重放回执、异参 409）；审计与业务同事务（注入 port）。
 */
import { BillingErrors } from '../../../domain/errors.js';
import type { BillingStore } from '../../../ports/billing-store.js';
import { createOperationsUseCase } from '../../operations.js';
import { assertReviewCommand, type ReviewAuditTx, type ReviewCommand } from './review-shared.js';

export interface RetryDeadInput extends ReviewCommand {
  adminId: number;
  operationId: string;
}

export interface RetryDeadResult {
  requestId: string;
  userId: number;
  status: string;
  revision: number;
  replayed: boolean;
}

// eslint-disable-next-line max-lines-per-function -- 死单处置事务体:顺序步骤
export async function retryDead(
  env: {
    store: Pick<
      BillingStore,
      | 'transaction'
      | 'findByRequestId'
      | 'casReviewRetryDead'
      | 'insertOperationPlaceholder'
      | 'findOperation'
      | 'saveOperationReceipt'
    > & { read?: unknown };
    clock: () => Date;
    auditTx?: ReviewAuditTx;
  },
  input: RetryDeadInput,
): Promise<RetryDeadResult> {
  assertReviewCommand(input);
  const operations = createOperationsUseCase({
    store: env.store as Parameters<typeof createOperationsUseCase>[0]['store'],
  });
  const { receipt, replayed } = await operations.run({
    operationId: input.operationId,
    kind: 'billing.retry_dead',
    payload: {
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
      adminId: input.adminId,
    },
    execute: async (tx) => {
      const retried = await env.store.casReviewRetryDead(tx, {
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        now: env.clock(),
      });
      if (!retried) {
        throw BillingErrors.business('state_conflict', {
          requestId: input.requestId,
          reason: 'not dead or revision mismatch',
        });
      }
      const row = await env.store.findByRequestId(tx, input.requestId);
      await env.auditTx?.(tx, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'billing.retry_dead',
        targetType: 'billing_request',
        targetId: input.requestId,
        detail: {
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          evidenceRefs: [...(input.evidenceRefs ?? [])],
          result: 'retry_wait',
        },
      });
      return {
        requestId: input.requestId,
        userId: row?.userId ?? 0,
        status: 'retry_wait',
        revision: row?.revision ?? 0,
      };
    },
  });
  return { ...receipt, replayed };
}
