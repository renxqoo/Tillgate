/**
 * settleClaim 用例：单张认领的结算编排——钱的落定（一个事务）。
 *
 *   认领复验（五元组 + 租约）→ 幂等回查（认领失效时 usage_logs 判 already_settled）
 *   → 归属/G1 估算/渠道一致性校验 → 金额（domain computeAmounts 双口径）
 *   → 分配（domain allocateSettlement：优先级序消耗，PAYG 超额走 §4）
 *   → 逐源 source.settle + 明细 markSettled
 *   → usage_logs 投影落库 → 渠道敞口归还 → CAS settled → 进货额度扣减（熔断）
 *
 * 本文件只有编排；分配/失败策略/解码守卫全部是 domain 纯函数。
 */
import {
  allocateSettlement,
  BillingInvariantError,
  computeAmounts,
  decodeReceipt,
  Decimal,
  isAttributedEstimate,
  normalizeAmount,
  ReceiptUserMismatchError,
} from '@ai-gateway/domain';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { ChannelBudgetCloseout } from '../channel-budget/index.js';
import type { RunContext } from '../context.js';
import { inTx } from '../context.js';
import type { FundingRegistry } from '../funding/registry.js';
import type { SourceReservation } from '../funding/source.js';
import { usageLogProjection } from './usage-projection.js';
import type { SettlementClaim } from './claim.js';

export interface SettleEnv {
  db: Db;
  fundingRegistry: FundingRegistry;
  channelBudget?: ChannelBudgetCloseout;
  clock?: () => Date;
  repos?: Repositories;
  /** 运营投影钩子（事务外 best-effort——TPM 回填/余额预警；异常不反杀结算） */
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

export function createSettleClaimUseCase(env: SettleEnv) {
  const { db, clock = () => new Date() } = env;
  const repos = env.repos ?? createRepositories();

  return async function settleClaim(
    ctx: RunContext,
    claim: SettlementClaim,
  ): Promise<SettleClaimResult> {
    // 解码守卫（毒收据 → 抛给失败路径判死信）；金额双口径在此算一次
    const receipt = decodeReceipt(claim.receipt);
    const { calculatedAmount, upstreamCost } = computeAmounts(receipt);

    let settledUserId = receipt.userId;
    const result = await db.transaction(async (tx): Promise<SettleClaimResult> => {
      const c = inTx(ctx, tx);
      const claimKeys = {
        requestId: claim.requestId,
        ownerId: claim.ownerId,
        claimToken: claim.claimToken,
        revision: claim.revision,
      };
      const billing = await repos.billingRequest.findProcessingForClaim(c, claimKeys);
      if (!billing) {
        // 认领失效：usage_logs 已有记录 = 已被并发方结算完成 → 幂等返回
        const prior = await repos.usageLog.findAmount(c, claim.requestId);
        if (prior != null) {
          return { outcome: 'already_settled', settled: false, amount: normalizeAmount(prior), channelCircuitBroken: false };
        }
        return { outcome: 'claim_lost', settled: false, amount: '0', channelCircuitBroken: false };
      }
      if (billing.userId !== receipt.userId) throw new ReceiptUserMismatchError();
      settledUserId = billing.userId;
      // G1：估算 usage 只允许归属「用户取消 ∪ 完成缺 usage」
      if (receipt.usage.estimated && !isAttributedEstimate(receipt)) {
        throw new BillingInvariantError('settle_estimated_usage');
      }
      // 渠道维度单一事实：收据渠道与账单预留渠道不一致 = 网关回归 → 死信
      if (
        billing.channelId != null &&
        receipt.channelId != null &&
        billing.channelId !== receipt.channelId
      ) {
        throw new BillingInvariantError('settle_channel_mismatch');
      }

      // 明细真相：Σ在途明细 = 账单总预扣（不符 = 投影脱节红灯）
      const reservations = await repos.billingReservation.findActive(c, claim.requestId);
      const total = reservations.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
      if (!total.eq(billing.reservedAmount)) {
        throw new BillingInvariantError('settle_reservation_projection_mismatch');
      }

      // 分配（domain 纯规则）：明细 id 序 = 消费优先级序 = 提交序
      const shares = allocateSettlement(
        reservations.map((row) => ({ sourceType: row.sourceType, amount: row.amount })),
        new Decimal(calculatedAmount),
      );
      const now = clock();
      let planConsume = new Decimal(0);
      for (let i = 0; i < shares.length; i++) {
        const share = shares[i]!;
        const reservation = reservations[i]!;
        const source = env.fundingRegistry.get(reservation.sourceType);
        await source.settle(c, {
          userId: billing.userId,
          requestId: claim.requestId,
          reservation: toSourceReservation(reservation),
          consume: share.consume,
          over: share.over,
          now,
        });
        if (!(await repos.billingReservation.markSettled(c, reservation.id, now))) {
          throw new BillingInvariantError('settle_reservation_already_finalized');
        }
        if (share.sourceType === 'subscription') {
          planConsume = planConsume.plus(share.consume);
        }
      }

      // usage_logs 投影（限额口径与报表的数据源；requestId 唯一约束幂等）
      const inserted = await repos.usageLog.insertUsageLog(
        c,
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
        }) as Parameters<typeof repos.usageLog.insertUsageLog>[1],
      );
      if (!inserted) throw new BillingInvariantError('settle_usage_conflict');

      await env.channelBudget?.releaseExposure(ctx, tx, {
        channelId: billing.channelId,
        channelReservedAmount: billing.channelReservedAmount,
      });

      if (!(await repos.billingRequest.casFinalizeSettled(c, claimKeys))) {
        throw new BillingInvariantError('settle_state_changed_during_settlement');
      }
      const channelCircuitBroken = await env.channelBudget?.deductBudget(ctx, tx, {
        channelId: receipt.channelId ?? billing.channelId,
        upstreamCost,
      });
      return {
        outcome: 'settled',
        settled: true,
        amount: normalizeAmount(calculatedAmount),
        channelCircuitBroken: channelCircuitBroken ?? false,
      };
    });

    // 运营投影（事务已提交）：TPM actual 回填 / balance_low 入箱——best-effort，
    // 钩子异常只记日志绝不改写资金结果
    if (result.outcome === 'settled') {
      try {
        env.onSettled?.({
          requestId: claim.requestId,
          userId: settledUserId,
          receipt: claim.receipt ?? (receipt as unknown as Record<string, unknown>),
          amount: result.amount,
        });
      } catch (error) {
        console.error(`[settlement] onSettled hook failed request=${claim.requestId}:`, error);
      }
    }
    return result;
  };
}
