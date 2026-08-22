/**
 * settlement 用例族装配出口（./settlement 窄子入口的装配体）：
 * claim / renewClaims / settleClaim / processClaim / finishFailure / recover /
 * abandonOwnedClaims / verifyInvariants（对账哨兵）。
 * worker 消费方按需取用；全部状态变化经 BillingStore 的 CAS/租约语义。
 */
import type { BillingStore } from '../../ports/billing-store.js';
import type { ChannelExposureStore } from '../../ports/funding-ports.js';
import type { WalletStore } from '../../ports/wallet-store.js';
import type { FundingRegistry } from '../billing/funding/registry.js';
import { createClaimUseCase, createRenewClaimsUseCase, type ClaimInput } from './claim.js';
import type { SettlementClaim } from './claim.js';
import { createFailureUseCase } from './failure.js';
import { createProcessClaimUseCase } from './process.js';
import { createSettleClaimUseCase } from './settle.js';
import type { SettleClaimResult } from './settle.js';
import {
  createAbandonClaimsUseCase,
  createRecoverUseCase,
  type RecoveryRunResult,
} from './recover.js';
import { createReconcileUseCase } from './reconcile.js';
import type { ReconcileReport } from './reconcile.js';
import type { SettleFailurePolicyConfig } from '../../domain/billing/settle-failure.js';

export type { SettlementClaim, ClaimInput } from './claim.js';
export type { ClaimOutcome } from './process.js';
export type { SettleClaimResult } from './settle.js';
export type { RecoveryRunResult } from './recover.js';
export type { ReconcileReport, ReconcileViolation } from './reconcile.js';

export interface SettlementDeps {
  store: BillingStore;
  walletStore: WalletStore;
  fundingRegistry: FundingRegistry;
  channels?: ChannelExposureStore;
  /** 失败策略参数（装配必填） */
  failurePolicy: SettleFailurePolicyConfig;
  clock?: () => Date;
  onSettled?: Parameters<typeof createSettleClaimUseCase>[0]['onSettled'];
  onDead?: (data: {
    requestId: string;
    failureClass: string;
    attempt: number;
    lastError: string;
  }) => void;
}

export interface SettlementApi {
  claim(input: ClaimInput): Promise<SettlementClaim[]>;
  renewClaims(input: {
    ownerId: string;
    tokens: readonly string[];
    claimLeaseMs: number;
  }): Promise<void>;
  settleClaim(claim: SettlementClaim): Promise<SettleClaimResult>;
  processClaim(claim: SettlementClaim): Promise<'settled' | 'retried' | 'dead' | 'claim_lost'>;
  recover(input: { batchSize: number }): Promise<RecoveryRunResult>;
  abandonOwnedClaims(ownerId: string): Promise<number>;
  verifyInvariants(): Promise<ReconcileReport>;
}

export function createSettlementApi(deps: SettlementDeps): SettlementApi {
  const settleClaim = createSettleClaimUseCase({
    store: deps.store,
    fundingRegistry: deps.fundingRegistry,
    channels: deps.channels,
    clock: deps.clock,
    onSettled: deps.onSettled,
  });
  const finishFailure = createFailureUseCase({
    store: deps.store,
    policy: deps.failurePolicy,
    onDead: deps.onDead,
  });
  return {
    claim: createClaimUseCase({ store: deps.store }),
    renewClaims: createRenewClaimsUseCase({ store: deps.store }),
    settleClaim,
    processClaim: createProcessClaimUseCase({ settleClaim, finishFailure }),
    recover: createRecoverUseCase({
      store: deps.store,
      fundingRegistry: deps.fundingRegistry,
      channels: deps.channels,
      clock: deps.clock,
    }),
    abandonOwnedClaims: createAbandonClaimsUseCase({ store: deps.store, clock: deps.clock }),
    verifyInvariants: createReconcileUseCase({ walletStore: deps.walletStore }),
  };
}
