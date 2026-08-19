/**
 * @ai-gateway/ledger/billing —— 计费域出口（S5 重写，钱包之上）。
 *
 * billing_requests 8 态业务状态机只编排不碰钱：PAYG 资金走 wallet
 * （authorize/settle/release，refType 'billing'，refId = requestId；冻结单
 * 不设 expiresAt——生命周期由本域显式管理）；订阅额度走 subscription.quota；
 * 渠道敞口走 channel-budget。结算「实际 > 预留」用 §4 补充授权模式
 * （同事务 authorize#over + settle#over + settle 原单）。
 *
 * 装配要求：wallet 的 refTypes 白名单须含 'billing'。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '@ai-gateway/db';
import type { Wallet } from '@ai-gateway/wallet';
import { reserveExposure } from '../channel-budget/exposure.js';
import { authorizeBilling } from './authorize.js';
import { signalBillingEvent } from './signal.js';
import { settleBillingClaim } from './settle.js';
import { createBillingReview, type BillingReview } from './dead.js';
import { createAdmission, type AdmissionGate } from './gates/admission.js';
import type {
  AuthorizeBillingCommand,
  BillingAuthorization,
  BillingEvent,
  BillingSignalResult,
  ChannelReservationResult,
  ReserveChannelCommand,
  SettleClaimResult,
  SettlementClaim,
} from './types.js';

export interface BillingDomain {
  authorize(command: AuthorizeBillingCommand): Promise<BillingAuthorization>;
  /** 渠道「进货额度」硬闸：选渠前预留在途上游成本敞口（换渠道原子释放旧敞口）。 */
  reserveChannel(command: ReserveChannelCommand): Promise<ChannelReservationResult>;
  signal(event: BillingEvent): Promise<BillingSignalResult>;
  /** 结算一个已持久化收据（processor 认领后调用；认领三元组 + 租约复验）。 */
  settleClaim(claim: SettlementClaim): Promise<SettleClaimResult>;
  /** 死单人工复核/放弃（管理端）。 */
  review(): BillingReview;
}

export interface BillingDomainDeps {
  db: Db;
  /** 资金动作：refTypes 白名单须含 'billing' */
  wallet: Wallet;
  clock?: () => Date;
  admission?: AdmissionGate;
}

export function createBillingDomain({
  db,
  wallet,
  clock = () => new Date(),
  admission,
}: BillingDomainDeps): BillingDomain {
  const admissionGate = admission ? createAdmission(db, admission) : undefined;
  return {
    authorize: (command) => authorizeBilling(db, wallet, clock, admissionGate, command),
    reserveChannel: (command) => reserveExposure(db, clock, command),
    signal: (event) => signalBillingEvent(db, wallet, clock, event),
    settleClaim: (claim) => settleBillingClaim(db, wallet, claim),
    review: () => createBillingReview({ db, wallet, clock }),
  };
}

export function newLeaseOwner(): string {
  return randomUUID();
}

export { createAdmission } from './gates/admission.js';
export type { Admission, AdmissionGate } from './gates/admission.js';
export type { BillingReview, BillingReviewCase, BillingReviewResult } from './dead.js';
export { BillingOperationError } from './review-errors.js';
