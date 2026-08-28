/**
 * settlement 用例族装配出口（./settlement 窄子入口的装配体）：
 * claim / renewClaims / settleClaim / processClaim / finishFailure / recover /
 * abandonOwnedClaims / verifyInvariants（对账哨兵）。
 * worker 消费方按需取用；全部状态变化经 BillingStore 的 CAS/租约语义。
 */
import type { BillingStore } from '../../ports/billing-store.js';
import type { ChannelExposureStore } from '../../ports/funding-ports.js';
import type { NotificationOutboxPort } from '../../ports/notification-outbox.js';
import type { WalletStore } from '../../ports/wallet-store.js';
import type { FundingRegistry } from '../billing/funding/registry.js';
import { createClaimUseCase, createRenewClaimsUseCase, type ClaimInput } from './claim.js';
import type { SettlementClaim } from './claim.js';
import { createFailureUseCase } from './failure.js';
import { createProcessClaimUseCase } from './process.js';
import { createSettleClaimUseCase, createSettleClaimsBatchUseCase } from './settle.js';
import type { SettleClaimResult } from './settle.js';
import {
  createAbandonClaimsUseCase,
  createRecoverUseCase,
  type RecoveryRunResult,
} from './recover.js';
import { createReconcileUseCase } from './reconcile.js';
import { listDead } from './review/list-dead.js';
import { retryDead } from './review/retry-dead.js';
import { abandonDead } from './review/abandon-dead.js';
import type { RetryDeadInput, RetryDeadResult } from './review/retry-dead.js';
import type { AbandonDeadInput, AbandonDeadResult } from './review/abandon-dead.js';
import type { ReviewAuditTx } from './review/review-shared.js';
import type { DeadCaseRow } from '../../ports/billing-store.js';
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
  /** 用量证据缺陷熔断阈值（装配必填——零写死） */
  usageDefectBreaker: number;
  /** 失败策略参数（装配必填） */
  failurePolicy: SettleFailurePolicyConfig;
  /** 时钟（装配必填——零写死） */
  clock: () => Date;
  /** recover 毒行隔离写入（装配必填：logger/遥测注入；console 直写是隐藏 I/O） */
  onError: (error: unknown, context: string) => void;
  /**
   * 可靠通知：死信事实同事务入箱（入箱失败回滚处置事务）。
   * 未注入时无通知副作用；可靠投递不走 onSettled/onDead 钩子。
   * 结算成功不入箱（无告警消费场景——见 settle.ts 尾注）。
   */
  outbox?: NotificationOutboxPort;
  onSettled?: Parameters<typeof createSettleClaimUseCase>[0]['onSettled'];
  /** 验收门钳制观察钩子（提交后 best-effort——装配接日志/审计） */
  onUsageDefect?: Parameters<typeof createSettleClaimUseCase>[0]['onUsageDefect'];
  /** 死信复核同事务审计 port（缺省丢弃——app 装配桥 observability writeAudit） */
  reviewAuditTx?: ReviewAuditTx;
  onDead?: (data: {
    requestId: string;
    failureClass: string;
    attempt: number;
    lastError: string;
  }) => void;
}

/** 死信复核组（admin-api 消费;审计与业务同事务经注入 port） */
export interface SettlementReviewApi {
  listDead(input: {
    limit: number;
    offset: number;
  }): Promise<{ rows: DeadCaseRow[]; total: number }>;
  retryDead(input: RetryDeadInput): Promise<RetryDeadResult>;
  abandonDead(input: AbandonDeadInput): Promise<AbandonDeadResult>;
}

export interface SettlementApi {
  /** 死信复核 */
  review: SettlementReviewApi;
  claim(input: ClaimInput): Promise<SettlementClaim[]>;
  /**
   * due 行只读扫描（不认领，无锁）：sweep 入队（BullMQ）与直驱 runner 的
   * 触发源共用；认领互斥仍由 claim 承担——多次/并发触发天然幂等。
   */
  listDueRequestIds(input: { limit: number }): Promise<string[]>;
  renewClaims(input: {
    ownerId: string;
    tokens: readonly string[];
    claimLeaseMs: number;
  }): Promise<void>;
  settleClaim(claim: SettlementClaim): Promise<SettleClaimResult>;
  /**
   * 批量结算：共享一个事务（账户行锁一次拿放——摊薄 platform_revenue 单行
   * 串行化）。批内任一账单失败整批回滚上抛；调用方回退逐张 processClaim
   * 隔离毒账单。空数组安全返回空。
   */
  settleClaims(claims: readonly SettlementClaim[]): Promise<SettleClaimResult[]>;
  processClaim(claim: SettlementClaim): Promise<'settled' | 'retried' | 'dead' | 'claim_lost'>;
  recover(input: { batchSize: number }): Promise<RecoveryRunResult>;
  abandonOwnedClaims(ownerId: string): Promise<number>;
  verifyInvariants(): Promise<ReconcileReport>;
  /**
   * billing_requests 当前状态（只读；null = 行不存在）——生成任务轮询终态的
   * 自愈判定用（已 settlement_pending/settled 则跳过 succeeded 信号直接终态化，
   * worker 消费）。
   */
  currentStatus(requestId: string): Promise<string | null>;
}

// eslint-disable-next-line max-lines-per-function -- 结算门面编排
export function createSettlementApi(deps: SettlementDeps): SettlementApi {
  const settleClaim = createSettleClaimUseCase({
    store: deps.store,
    fundingRegistry: deps.fundingRegistry,
    channels: deps.channels,
    usageDefectBreaker: deps.usageDefectBreaker,
    clock: deps.clock,
    onSettled: deps.onSettled,
    onUsageDefect: deps.onUsageDefect,
  });
  const settleClaims = createSettleClaimsBatchUseCase({
    store: deps.store,
    fundingRegistry: deps.fundingRegistry,
    channels: deps.channels,
    usageDefectBreaker: deps.usageDefectBreaker,
    clock: deps.clock,
    onSettled: deps.onSettled,
    onUsageDefect: deps.onUsageDefect,
  });
  const finishFailure = createFailureUseCase({
    store: deps.store,
    policy: deps.failurePolicy,
    outbox: deps.outbox,
    onDead: deps.onDead,
  });
  return {
    review: {
      listDead: (input) => listDead({ store: deps.store }, input),
      retryDead: (input) =>
        retryDead(
          {
            store: deps.store,
            clock: deps.clock,
            ...(deps.reviewAuditTx !== undefined ? { auditTx: deps.reviewAuditTx } : {}),
          },
          input,
        ),
      abandonDead: (input) =>
        abandonDead(
          {
            store: deps.store,
            fundingRegistry: deps.fundingRegistry,
            ...(deps.channels !== undefined ? { channels: deps.channels } : {}),
            clock: deps.clock,
            ...(deps.reviewAuditTx !== undefined ? { auditTx: deps.reviewAuditTx } : {}),
          },
          input,
        ),
    },
    claim: createClaimUseCase({ store: deps.store }),
    listDueRequestIds: (input) =>
      deps.store.read((conn) => deps.store.listDueSettlementRequests(conn, input)),
    renewClaims: createRenewClaimsUseCase({ store: deps.store }),
    settleClaim,
    settleClaims,
    processClaim: createProcessClaimUseCase({ settleClaim, finishFailure }),
    recover: createRecoverUseCase({
      store: deps.store,
      fundingRegistry: deps.fundingRegistry,
      channels: deps.channels,
      clock: deps.clock,
      onError: deps.onError,
    }),
    abandonOwnedClaims: createAbandonClaimsUseCase({ store: deps.store, clock: deps.clock }),
    verifyInvariants: createReconcileUseCase({
      walletStore: deps.walletStore,
      clock: deps.clock,
    }),
    currentStatus: (requestId: string) =>
      deps.store.read((conn) => deps.store.currentStatus(conn, requestId)),
  };
}
