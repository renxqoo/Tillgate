/**
 * failure 用例：结算失败处置——domain 策略（死信家族/退避/次数上限）判定，
 * CAS processing → retry_wait（退避后可重领）或 dead（人工复核）。
 */
import {
  settleFailurePolicy,
  type SettleFailurePolicyConfig,
} from '../../domain/billing/settle-failure.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { NotificationOutboxPort } from '../../ports/notification-outbox.js';
import type { SettlementClaim } from './claim.js';

export type FailureOutcome = 'retried' | 'dead';

const LAST_ERROR_MAX = 500;

// eslint-disable-next-line max-lines-per-function -- 失败策略事务体:策略分支矩阵
export function createFailureUseCase(env: {
  store: BillingStore;
  /** 失败策略参数（装配必填——最大尝试/退避不写死） */
  policy: SettleFailurePolicyConfig;
  /**
   * 可靠通知（§5.4）：死信事实同事务入箱——append 抛错则死信处置整体回滚
   * （行停留 processing，由租约恢复重试）。未注入时无通知副作用。
   */
  outbox?: NotificationOutboxPort;
  /**
   * 提交后观察钩子（事务已提交后的 metrics/告警best-effort——可丢，
   * 异常不反杀处置）。可靠投递走 outbox port。
   */
  onDead?: (data: {
    requestId: string;
    failureClass: string;
    attempt: number;
    lastError: string;
  }) => void;
}) {
  const { store } = env;
  // eslint-disable-next-line max-lines-per-function -- 失败策略事务体:策略分支矩阵
  return async function finishFailure(
    claim: SettlementClaim,
    error: unknown,
  ): Promise<FailureOutcome> {
    const decision = settleFailurePolicy(error, { ...env.policy, attempt: claim.attempt });
    const lastError = (error instanceof Error ? error.message : String(error)).slice(
      0,
      LAST_ERROR_MAX,
    );
    const changed = await store.transaction(async (tx) => {
      const ok = await store.casToRetryOrDead(
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
      );
      // 可靠通知同事务入箱：事件名对齐 notifications 封闭词表（billing_dead——
      // 下划线；点分名会在消费方 enqueue 词表门抛 unknown_event 回滚死信处置）。
      // dedupe 键含 attempt——同一死信判定的重试/重放由消费方幂等吸收；
      // 人工复活后再次死信（attempt 递增）是新事实。
      if (ok && decision.dead) {
        await env.outbox?.append(tx, {
          dedupeKey: `billing.dead:${claim.requestId}:${claim.attempt}`,
          event: 'billing_dead',
          payload: {
            requestId: claim.requestId,
            failureClass: decision.failureClass,
            attempt: claim.attempt,
            lastError,
          },
        });
      }
      return ok;
    });
    if (changed && decision.dead) {
      try {
        env.onDead?.({
          requestId: claim.requestId,
          failureClass: decision.failureClass,
          attempt: claim.attempt,
          lastError,
        });
      } catch {
        // 观察钩子失败不反杀处置（best-effort，可丢——可靠通道是 outbox port）
      }
    }
    return decision.dead ? 'dead' : 'retried';
  };
}
