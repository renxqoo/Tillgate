/**
 * failure 用例：结算失败处置——domain 策略（死信家族/退避/次数上限）判定，
 * CAS processing → retry_wait（退避后可重领）或 dead（人工复核）。
 */
import { settleFailurePolicy, type SettleFailurePolicyConfig } from '@ai-gateway/domain';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import { inTx } from '../context.js';
import type { SettlementClaim } from './claim.js';

export interface FailureEnv {
  db: Db;
  /** 失败策略参数（装配必填——最大尝试/退避不写死） */
  policy: SettleFailurePolicyConfig;
  repos?: Repositories;
}

export type FailureOutcome = 'retried' | 'dead';

const LAST_ERROR_MAX = 500;

export function createFailureUseCase(env: FailureEnv) {
  const repos = env.repos ?? createRepositories();
  return async function finishFailure(
    ctx: RunContext,
    claim: SettlementClaim,
    error: unknown,
  ): Promise<FailureOutcome> {
    const decision = settleFailurePolicy(error, { ...env.policy, attempt: claim.attempt });
    const lastError = (error instanceof Error ? error.message : String(error)).slice(
      0,
      LAST_ERROR_MAX,
    );
    const changed = await env.db.transaction((tx) =>
      repos.billingRequest.casToRetryOrDead(
        inTx(ctx, tx),
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
    if (!changed) {
      // 认领已被回收/接管：幂等让位（recover 已重排，或并发方已处置）
      return decision.dead ? 'dead' : 'retried';
    }
    return decision.dead ? 'dead' : 'retried';
  };
}
