/**
 * settleClaim 用例：单张认领的结算编排——钱的落定（一个事务）。
 *
 *   认领复验（五元组 + 租约）→ 幂等回查（认领失效时 usage_logs 判 already_settled）
 *   → 归属/G1 估算/渠道一致性校验 → 金额（domain computeAmounts 双口径）
 *   → 分配（domain allocateSettlement：优先级序消耗，PAYG 超额走补充授权）
 *   → 逐源 source.settle + 明细 markSettled
 *   → usage_logs 投影落库 → 渠道敞口归还 → CAS settled → 进货额度扣减（熔断）
 *
 * 本文件只有编排；分配/失败策略/解码守卫全部是 domain 纯函数。
 * 不变量红灯（原 WalletInvariantError 家族）以 DefectError 表达——自动进死信家族。
 */
import { DefectError } from '@tillgate/errors';
import { BillingErrors } from '../../domain/errors.js';
import { allocateSettlement } from '../../domain/billing/settle-allocation.js';
import { computeAmounts } from '../../domain/rating/amounts.js';
import { decodeReceipt } from '../../domain/rating/decode.js';
import { isAttributedEstimate, type UsageReceipt } from '../../domain/rating/types.js';
import { Decimal, normalizeAmount } from '../../domain/money.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { ChannelExposureStore } from '../../ports/funding-ports.js';
import type { FundingRegistry } from '../billing/funding/registry.js';
import type { SourceReservation } from '../billing/funding/source.js';
import { usageLogProjection } from './usage-projection.js';
import type { SettlementClaim } from './claim.js';

export interface SettleEnv {
  store: BillingStore;
  fundingRegistry: FundingRegistry;
  channels?: ChannelExposureStore;
  /** 时钟（装配必填——零写死；DB 时钟权威路径不在此） */
  clock: () => Date;
  /**
   * 提交后观察钩子（事务已提交后的 metrics/trace 级 best-effort——可丢，
   * 异常不反杀结算）。可靠投递走 outbox port，本钩子不承载资金所需事实。
   */
  onSettled?: (data: {
    requestId: string;
    userId: number;
    receipt: Record<string, unknown>;
    amount: string;
  }) => void;
}

export interface SettleClaimResult {
  outcome: 'settled' | 'already_settled' | 'claim_lost';
  settled: boolean;
  amount: string;
  channelCircuitBroken: boolean;
}

/** 明细行 → 来源预占（domain 分配与 source.settle 的共同词汇） */
function toSourceReservation(row: {
  billingRequestId: string;
  sourceType: string;
  sourceRefId: number | null;
  amount: string;
}): SourceReservation {
  return {
    billingRequestId: row.billingRequestId,
    sourceType: row.sourceType,
    sourceRefId: row.sourceRefId,
    amount: row.amount,
  };
}

function invariant(code: string): DefectError {
  return new DefectError(code, 'billing.billing_invariant', { code });
}

// eslint-disable-next-line max-lines-per-function -- 结算状态机事务体:投影校验→分配→逐源核销,拆分需共享 tx 与计数器
export function createSettleClaimUseCase(env: SettleEnv) {
  const { store, clock } = env;

  // eslint-disable-next-line max-lines-per-function -- 结算状态机事务体:投影校验→分配→逐源核销,拆分需共享 tx 与计数器
  return async function settleClaim(claim: SettlementClaim): Promise<SettleClaimResult> {
    // 解码守卫（毒收据 → 抛给失败路径判死信）；金额双口径在此算一次
    const receipt = decodeReceipt(claim.receipt as UsageReceipt | null);
    const { calculatedAmount, upstreamCost } = computeAmounts(receipt);

    let settledUserId = receipt.userId;
    // eslint-disable-next-line complexity, max-lines-per-function, max-statements -- 结算状态机事务体:投影校验→分配→逐源核销,拆分需共享 tx 与计数器
    const result = await store.transaction(async (tx): Promise<SettleClaimResult> => {
      const claimKeys = {
        requestId: claim.requestId,
        ownerId: claim.ownerId,
        claimToken: claim.claimToken,
        revision: claim.revision,
      };
      const billing = await store.findProcessingForClaim(tx, claimKeys);
      if (!billing) {
        // 认领失效：usage_logs 已有记录 = 已被并发方结算完成 → 幂等返回
        const prior = await store.findUsageAmount(tx, claim.requestId);
        if (prior != null) {
          return {
            outcome: 'already_settled',
            settled: false,
            amount: normalizeAmount(prior),
            channelCircuitBroken: false,
          };
        }
        return { outcome: 'claim_lost', settled: false, amount: '0', channelCircuitBroken: false };
      }
      if (billing.userId !== receipt.userId) {
        throw BillingErrors.business('receipt_user_mismatch', {
          expected: billing.userId,
          actual: receipt.userId,
        });
      }
      settledUserId = billing.userId;
      // G1：估算 usage 只允许归属「用户取消 ∪ 完成缺 usage」
      if (receipt.usage.estimated && !isAttributedEstimate(receipt)) {
        throw invariant('settle_estimated_usage');
      }
      // 渠道维度单一事实：收据渠道与账单预留渠道不一致 = 网关回归 → 死信
      if (
        billing.channelId != null &&
        receipt.channelId != null &&
        billing.channelId !== receipt.channelId
      ) {
        throw invariant('settle_channel_mismatch');
      }

      // 明细真相：Σ在途明细 = 账单总预扣（不符 = 投影脱节红灯）
      const reservations = await store.findActiveReservations(tx, claim.requestId);
      const total = reservations.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
      if (!total.eq(billing.reservedAmount)) {
        throw invariant('settle_reservation_projection_mismatch');
      }

      // 分配（domain 纯规则）：明细 id 序 = 消费优先级序 = 提交序
      const shares = allocateSettlement(
        reservations.map((row) => ({ sourceType: row.sourceType, amount: row.amount })),
        new Decimal(calculatedAmount),
      );
      const now = clock();
      let planConsume = new Decimal(0);
      for (let i = 0; i < shares.length; i++) {
        const share = shares[i];
        const reservation = reservations[i];
        if (share === undefined || reservation === undefined) {
          throw invariant('settle_share_index_mismatch');
        }
        const source = env.fundingRegistry.get(reservation.sourceType);
        await source.settle(tx, {
          userId: billing.userId,
          requestId: claim.requestId,
          reservation: toSourceReservation(reservation),
          consume: share.consume,
          over: share.over,
          now,
        });
        if (!(await store.markReservationSettled(tx, reservation.id, now))) {
          throw invariant('settle_reservation_already_finalized');
        }
        if (share.sourceType === 'subscription') {
          planConsume = planConsume.plus(share.consume);
        }
      }

      // usage_logs 投影（限额口径与报表的数据源；requestId 唯一约束幂等）
      const inserted = await store.insertUsageLog(
        tx,
        usageLogProjection({
          receipt,
          billing: {
            userId: billing.userId,
            subscriptionId: billing.subscriptionId,
            channelId: billing.channelId,
          },
          calculatedAmount,
          upstreamCost,
          planConsume: planConsume.toString(),
        }),
      );
      if (!inserted) throw invariant('settle_usage_conflict');

      if (billing.channelId != null && billing.channelReservedAmount != null) {
        const returned = await env.channels?.tryDecreaseReserved(tx, {
          channelId: billing.channelId,
          amount: billing.channelReservedAmount,
          now,
        });
        if (env.channels && !returned) {
          throw new DefectError(
            `release ${billing.channelReservedAmount} on channel ${billing.channelId}`,
            'billing.channel_exposure_invariant',
          );
        }
      }

      if (!(await store.casFinalizeSettled(tx, claimKeys))) {
        throw invariant('settle_state_changed_during_settlement');
      }
      let channelCircuitBroken = false;
      const deductChannel = receipt.channelId ?? billing.channelId;
      if (env.channels && deductChannel != null) {
        channelCircuitBroken = await env.channels.deductBudgetAndMaybeBreak(tx, {
          channelId: deductChannel,
          upstreamCost,
          now,
        });
      }

      // 结算成功事实不入通知 outbox（v2 口径，v1 同款）：notifications 词表无
      // 「结算成功」成员——无告警消费场景；可观测走 usage_logs 投影与 onSettled
      // 钩子（best-effort）。可靠入箱只有死信路径（failure 用例，billing_dead）。
      return {
        outcome: 'settled',
        settled: true,
        amount: normalizeAmount(calculatedAmount),
        channelCircuitBroken,
      };
    });

    // 提交后观察钩子（metrics/trace 级 best-effort——可丢，异常不反杀结算）。
    // 本钩子仅承载可丢的运营投影（TPM 回填/余额预警），不是通知通道。
    if (result.outcome === 'settled') {
      try {
        env.onSettled?.({
          requestId: claim.requestId,
          userId: settledUserId,
          receipt: claim.receipt ?? (receipt as unknown as Record<string, unknown>),
          amount: result.amount,
        });
      } catch {
        // onSettled 钩子失败不反杀结算
      }
    }
    return result;
  };
}
