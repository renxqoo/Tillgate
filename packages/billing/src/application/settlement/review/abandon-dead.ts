/**
 * 死信弃单（U6）：CAS dead→released + 三路归还（钱包授权/订阅配额/渠道敞口——
 * 复用 U3 releaseAllReservations，与 recover①② 同一实现）。归还失败回滚整个事务
 * （state_conflict，不是 404——v1 语义）。审计与业务同事务（注入 port）。
 */
import { BillingErrors } from '../../../domain/errors.js';
import type { ChannelExposureStore } from '../../../ports/funding-ports.js';
import type { FundingRegistry } from '../../billing/funding/registry.js';
import { createReleaseAllReservations } from '../../billing/funding/release.js';
import { createOperationsUseCase } from '../../operations.js';
import { assertReviewCommand, type ReviewAuditTx, type ReviewCommand } from './review-shared.js';

export interface AbandonDeadInput extends ReviewCommand {
  adminId: number;
  operationId: string;
}

export interface AbandonDeadResult {
  requestId: string;
  released: boolean;
  replayed: boolean;
}

export async function abandonDead(
  env: {
    store: Parameters<typeof createOperationsUseCase>[0]['store'];
    fundingRegistry: FundingRegistry;
    channels?: ChannelExposureStore;
    clock: () => Date;
    auditTx?: ReviewAuditTx;
  },
  input: AbandonDeadInput,
): Promise<AbandonDeadResult> {
  assertReviewCommand(input);
  const operations = createOperationsUseCase({ store: env.store });
  const releaseAllReservations = createReleaseAllReservations({
    registry: env.fundingRegistry,
    channels: env.channels,
    store: env.store,
  });
  const { receipt, replayed } = await operations.run({
    operationId: input.operationId,
    kind: 'billing.abandon_dead',
    payload: {
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
      adminId: input.adminId,
    },
    execute: async (tx) => {
      const row = await env.store.casReviewAbandonDead(tx, {
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        now: env.clock(),
      });
      if (row === null) {
        throw BillingErrors.business('state_conflict', {
          requestId: input.requestId,
          reason: 'not dead or revision mismatch',
        });
      }
      await releaseAllReservations(tx, {
        requestId: input.requestId,
        reservedAmount: row.reservedAmount,
        channelId: row.channelId,
        channelReservedAmount: row.channelReservedAmount,
        now: env.clock(),
      });
      await env.auditTx?.(tx, {
        actor: 'admin',
        adminId: input.adminId,
        action: 'billing.abandon_dead',
        targetType: 'billing_request',
        targetId: input.requestId,
        detail: {
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          evidenceRefs: [...(input.evidenceRefs ?? [])],
          result: 'released',
        },
      });
      return { requestId: input.requestId, released: true };
    },
  });
  return { ...receipt, replayed };
}
