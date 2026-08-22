/**
 * processClaim 用例：单张认领的结算管线（编排壳）——
 * decode/settle 内聚在 settleClaim；抛错走 finishFailure 分类处置。
 * claim_lost = 认领被并发方拿走，幂等安全不计失败。
 */
import type { SettlementClaim } from './claim.js';
import type { FailureOutcome } from './failure.js';
import type { SettleClaimResult } from './settle.js';

export type ClaimOutcome = 'settled' | FailureOutcome | 'claim_lost';

export interface ProcessClaimDeps {
  settleClaim: (claim: SettlementClaim) => Promise<SettleClaimResult>;
  finishFailure: (claim: SettlementClaim, error: unknown) => Promise<FailureOutcome>;
}

export function createProcessClaimUseCase(deps: ProcessClaimDeps) {
  return async function processClaim(claim: SettlementClaim): Promise<ClaimOutcome> {
    try {
      const result = await deps.settleClaim(claim);
      // already_settled = 他方已完成我方认领失效（幂等安全）——与 claim_lost 同为
      // 非失败路径，但指标上不应混入「认领被抢」；映射为 settled 侧的重复计数
      return result.outcome === 'settled' || result.outcome === 'already_settled'
        ? 'settled'
        : 'claim_lost';
    } catch (error) {
      return deps.finishFailure(claim, error);
    }
  };
}
