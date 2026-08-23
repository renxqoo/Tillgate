/**
 * ./settlement 窄子入口：只装配结算与恢复 + 对账核验（worker 消费方专用）。
 * 需要 funding 来源（结算逐源核销）——装配便捷件在 ./composition。
 */
export {
  createSettlementApi,
  type SettlementApi,
  type SettlementDeps,
  type SettlementClaim,
  type ClaimInput,
  type ClaimOutcome,
  type SettleClaimResult,
  type RecoveryRunResult,
  type ReconcileReport,
  type ReconcileViolation,
} from './application/settlement/settlement.js';
export { createReconcileUseCase } from './application/settlement/reconcile.js';
export {
  createRecoverUseCase,
  createAbandonClaimsUseCase,
} from './application/settlement/recover.js';
export { createRecordDiscrepanciesUseCase } from './application/settlement/record-discrepancies.js';
