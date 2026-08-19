/**
 * @ai-gateway/ledger/settlement —— 结算 worker 编排域出口（S6）。
 *
 * BullMQ 队列契约、SKIP LOCKED 认领、租约三元组、失败分类重试、滞留恢复、
 * 库存——纯编排，只调用 billing 域的 settleClaim（钱包实现），不做领域判定。
 * 自 billing/processor/* 平移；行为零变更（分类器新增 wallet 错误类型）。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@ai-gateway/db';
import type { Wallet } from '@ai-gateway/wallet';
import { settleBillingClaim } from '../billing/settle.js';
import type {
  BillingEffects,
  BillingInventory,
  RecoveryRunResult,
  SettleClaimResult,
  SettlementClaim,
  SettlementProcessorOptions,
  SettlementRunResult,
} from '../billing/types.js';
import { runOnce } from './run-once.js';
import { recoverOnce } from './recover.js';
import { abandonOwnedClaims, inventory } from './inventory.js';

export interface SettlementProcessor {
  runOnce(requestIds?: string[]): Promise<SettlementRunResult>;
  recoverOnce(): Promise<RecoveryRunResult>;
  inventory(): Promise<BillingInventory>;
  abandonOwnedClaims(): Promise<number>;
}

export interface SettlementProcessorDeps {
  db: Db;
  /** 资金动作（billing settleClaim 内部使用；refTypes 须含 'billing'） */
  wallet: Wallet;
  options: SettlementProcessorOptions;
  effects?: BillingEffects;
  clock?: () => Date;
  random?: () => number;
}

/** 多副本安全的结算处理器（纯装配；所有业务重试状态都在 PostgreSQL，BullMQ 只负责 kick）。 */
export function createSettlementProcessor({
  db,
  wallet,
  options,
  effects,
  clock = () => new Date(),
  random = Math.random,
}: SettlementProcessorDeps): SettlementProcessor {
  const settleClaim = (claim: SettlementClaim): Promise<SettleClaimResult> =>
    settleBillingClaim(db, wallet, claim);
  return {
    runOnce: (requestIds) => runOnce(db, settleClaim, options, effects, clock, random, requestIds),
    recoverOnce: () => recoverOnce(db, wallet, options),
    inventory: () => inventory(db, clock),
    abandonOwnedClaims: () => abandonOwnedClaims(db, options, clock),
  };
}

export function newProcessorOwnerId(prefix = 'billing-worker'): string {
  return `${prefix}:${randomUUID()}`;
}

export { BILLING_SETTLEMENT_QUEUE } from './queue-contract.js';
export type { BillingSettlementWakeup } from './queue-contract.js';
export { classifyFailure, isPermanent, retryDelayMs } from './failure.js';
export type { ClaimOutcome } from './process-claim.js';
export { createRedisBillingEffects } from './effects.js';
export { backfillTpm } from './tpm-backfill.js';
