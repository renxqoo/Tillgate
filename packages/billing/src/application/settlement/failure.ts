/**
 * failure 用例：结算失败处置——domain 策略（死信家族/退避/次数上限）判定，
 * CAS processing → retry_wait（退避后可重领）或 dead（人工复核）。
 */
import {
  settleFailurePolicy,
  type SettleFailurePolicyConfig,
} from '../../domain/billing/settle-failure.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { SettlementClaim } from './claim.js';

export type FailureOutcome = 'retried' | 'dead';

const LAST_ERROR_MAX = 500;

export function createFailureUseCase(env: {
  store: BillingStore;
  /** 失败策略参数（装配必填——最大尝试/退避不写死） */
  policy: SettleFailurePolicyConfig;
  /** 死信钩子（billing_dead 告警入箱；事务外 best-effort） */
  onDead?: (data: {
    requestId: string;
    failureClass: string;
    attempt: number;
    lastError: string;
  }) => void;
}) {
  const { store } = env;
  return async function finishFailure(
    claim: SettlementClaim,
    error: unknown,
  ): Promise<FailureOutcome> {
    const decision = settleFailurePolicy(error, { ...env.policy, attempt: claim.attempt });
    const lastError = (error instanceof Error ? error.message : String(error)).slice(
      0,
      LAST_ERROR_MAX,
    );
    const changed = await store.transaction((tx) =>
      store.casToRetryOrDead(
        tx,
        {
          requestId: claim.requestId,
          ownerId: claim.ownerId,
          claimToken: claim.claimToken,
          revision: claim.revision,
        },
        {
          dead: decision.dead,
          nextDelayMs: decision.dead ? null : decision.retryInMs,
          failureClass: decision.failureClass,
          lastError,
        },
      ),
    );
    if (changed && decision.dead) {
      try {
        env.onDead?.({
          requestId: claim.requestId,
          failureClass: decision.failureClass,
          attempt: claim.attempt,
          lastError,
        });
      } catch {
        // 告警钩子失败不反杀结算处置（best-effort）
      }
    }
    return decision.dead ? 'dead' : 'retried';
  };
}
