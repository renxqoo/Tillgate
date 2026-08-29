/**
 * settleClaim 用例：单张/批量认领的结算编排——钱的落定（一个事务）。
 *
 *   认领复验（五元组 + 租约）→ 幂等回查（认领失效时 usage_logs 判 already_settled）
 *   → 归属/估算/渠道一致性校验 → 金额（domain computeAmounts 双口径）
 *   → 分配（domain allocateSettlement：优先级序消耗；超额钳制到可收额，差额 waived）
 *   → 逐源 source.settle + 明细 markSettled
 *   → usage_logs 投影落库 → 渠道敞口归还 → CAS settled → 进货额度扣减（熔断）
 *
 * 本文件只有编排；分配/失败策略/解码守卫全部是 domain 纯函数。
 * 不变量红灯以 DefectError 表达——自动进死信家族。
 *
 * 批量形态（settleClaims）：N 张账单共享一个事务——钱包双腿的账户行锁
 * （用户钱包 + platform_revenue 内部账户）只拿放一次，摊薄单行串行化成本；
 * 批内任一账单红灯即整批回滚，由调用方回退逐张结算隔离毒账单。
 */
import { DefectError } from '@tillgate/errors';
import { BillingErrors } from '../../domain/errors.js';
import { allocateSettlement } from '../../domain/billing/settle-allocation.js';
import { computeAmounts } from '../../domain/rating/amounts.js';
import { acceptTrustedUsage, type UsageClamp } from '../../domain/rating/usage-acceptance.js';
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
  /** 用量证据缺陷熔断阈值（验收门钳制计数 ≥ 阈值 → 渠道熔断；装配必填——零写死） */
  usageDefectBreaker: number;
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
    waived?: string;
  }) => void;
  /** 验收门钳制观察钩子（提交后 best-effort——装配接日志/审计；异常不反杀结算） */
  onUsageDefect?: (data: {
    requestId: string;
    channelId: number | null;
    clamps: readonly UsageClamp[];
    defects: number | null;
    broken: boolean;
  }) => void;
}

export interface SettleClaimResult {
  outcome: 'settled' | 'already_settled' | 'claim_lost';
  settled: boolean;
  amount: string;
  /** 超收放弃额（'0' = 无放弃）——available 不足时 actual 与实收的差额 */
  waived: string;
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

/** 单张账单的事务体（共享 tx）——结果与收单用户一起返回（无外层闭包可变状态） */
// eslint-disable-next-line complexity, max-lines-per-function, max-statements -- 结算状态机事务体:投影校验→分配→逐源核销,拆分需共享 tx 与计数器
async function settleOneInTx(
  env: SettleEnv,
  tx: Parameters<Parameters<BillingStore['transaction']>[0]>[0],
  claim: SettlementClaim,
): Promise<{
  result: SettleClaimResult;
  settledUserId: number | null;
  usageDefect: Parameters<NonNullable<SettleEnv['onUsageDefect']>>[0] | null;
}> {
  const { store, clock } = env;
  // 解码守卫（毒收据 → 抛给失败路径判死信）
  const decoded = decodeReceipt(claim.receipt as UsageReceipt | null);

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
        result: {
          outcome: 'already_settled',
          settled: false,
          amount: normalizeAmount(prior),
          waived: '0',
          channelCircuitBroken: false,
        },
        settledUserId: null,
        usageDefect: null,
      };
    }
    return {
      result: {
        outcome: 'claim_lost',
        settled: false,
        amount: '0',
        waived: '0',
        channelCircuitBroken: false,
      },
      settledUserId: null,
      usageDefect: null,
    };
  }
  if (billing.userId !== decoded.userId) {
    throw BillingErrors.business('receipt_user_mismatch', {
      expected: billing.userId,
      actual: decoded.userId,
    });
  }
  // 验收门：上游发票只是线索——可信 usage 按准入界（quote）与证据界钳定后，
  // 三本账（用户扣费/渠道扣减/平台收入）同源消费同一验收值；钳制事实走缺陷通道。
  const { receipt, clamps } = acceptTrustedUsage({ receipt: decoded, quote: billing.quote });
  const { calculatedAmount, upstreamCost } = computeAmounts(receipt);
  // 估算 usage 只允许归属「用户取消 ∪ 完成缺 usage」
  if (receipt.usage.estimated && !isAttributedEstimate(receipt)) {
    throw invariant('settle_estimated_usage');
  }
  // B4 经济闭合（钳后应为定理：预留 = 物理最坏 Case ≥ 钳定用量官方成本）——
  // 违反即内部不一致（价格快照漂移/投影脱节），红灯死信不入账
  if (
    billing.channelReservedAmount != null &&
    new Decimal(upstreamCost).gt(new Decimal(billing.channelReservedAmount))
  ) {
    throw new DefectError(
      `upstreamCost ${upstreamCost} > reserved ${billing.channelReservedAmount} (request ${claim.requestId})`,
      'billing.usage_economic_bound',
    );
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
  let waivedTotal = new Decimal(0);
  for (let i = 0; i < shares.length; i++) {
    const share = shares[i];
    const reservation = reservations[i];
    if (share === undefined || reservation === undefined) {
      throw invariant('settle_share_index_mismatch');
    }
    const source = env.fundingRegistry.get(reservation.sourceType);
    const settled = await source.settle(tx, {
      userId: billing.userId,
      requestId: claim.requestId,
      reservation: toSourceReservation(reservation),
      consume: share.consume,
      over: share.over,
      now,
    });
    waivedTotal = waivedTotal.plus(new Decimal(settled.waived));
    if (!(await store.markReservationSettled(tx, reservation.id, now))) {
      throw invariant('settle_reservation_already_finalized');
    }
    if (share.sourceType === 'subscription') {
      planConsume = planConsume.plus(share.consume);
    }
  }
  // 实收金额 = 应收 − 放弃额（超收钳制）；waived > 0 = 运营信号，恒可结算
  const chargedAmount = new Decimal(calculatedAmount).minus(waivedTotal);

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
      calculatedAmount: chargedAmount.toString(),
      upstreamCost,
      planConsume: planConsume.toString(),
      clamps,
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

  // 验收门缺陷：同事务原子计数，过阈熔断（钳制结算照常完成——缺陷另路处置）
  let usageDefect: { defects: number | null; broken: boolean } | null = null;
  if (clamps.length > 0) {
    const defectChannel = receipt.channelId ?? billing.channelId;
    if (env.channels && defectChannel != null) {
      usageDefect = await env.channels.recordUsageDefect(tx, {
        channelId: defectChannel,
        threshold: env.usageDefectBreaker,
        now,
      });
    }
  }

  if (!(await store.casFinalizeSettled(tx, claimKeys, { waived: waivedTotal.toString() }))) {
    throw invariant('settle_state_changed_during_settlement');
  }
  let channelCircuitBroken = usageDefect?.broken === true;
  const deductChannel = receipt.channelId ?? billing.channelId;
  if (env.channels && deductChannel != null) {
    const budgetBroken = await env.channels.deductBudgetAndMaybeBreak(tx, {
      channelId: deductChannel,
      upstreamCost,
      now,
    });
    channelCircuitBroken = channelCircuitBroken || budgetBroken;
  }

  // 结算成功事实不入通知 outbox：notifications 词表无
  // 「结算成功」成员——无告警消费场景；可观测走 usage_logs 投影与 onSettled
  // 钩子（best-effort）。可靠入箱只有死信路径（failure 用例，billing_dead）。
  return {
    result: {
      outcome: 'settled',
      settled: true,
      amount: normalizeAmount(chargedAmount.toString()),
      waived: normalizeAmount(waivedTotal.toString()),
      channelCircuitBroken,
    },
    settledUserId: billing.userId,
    usageDefect:
      clamps.length > 0
        ? {
            requestId: claim.requestId,
            channelId: receipt.channelId ?? billing.channelId,
            clamps,
            defects: usageDefect?.defects ?? null,
            broken: usageDefect?.broken === true,
          }
        : null,
  };
}

/** 提交后观察钩子（best-effort——可丢，异常不反杀结算） */
function fireOnSettled(
  env: SettleEnv,
  data: Parameters<NonNullable<SettleEnv['onSettled']>>[0],
): void {
  try {
    env.onSettled?.(data);
  } catch {
    // onSettled 钩子失败不反杀结算
  }
}

function fireOnUsageDefect(
  env: SettleEnv,
  data: Parameters<NonNullable<SettleEnv['onUsageDefect']>>[0],
): void {
  try {
    env.onUsageDefect?.(data);
  } catch {
    // 缺陷钩子失败不反杀结算（计数与熔断已在事务内完成）
  }
}

export function createSettleClaimUseCase(env: SettleEnv) {
  return async function settleClaim(claim: SettlementClaim): Promise<SettleClaimResult> {
    const { result, settledUserId, usageDefect } = await env.store.transaction(async (tx) =>
      settleOneInTx(env, tx, claim),
    );
    if (usageDefect != null) fireOnUsageDefect(env, usageDefect);
    if (result.outcome === 'settled' && settledUserId != null) {
      fireOnSettled(env, {
        requestId: claim.requestId,
        userId: settledUserId,
        receipt: claim.receipt ?? {},
        amount: result.amount,
        waived: result.waived,
      });
    }
    return result;
  };
}

/**
 * 批量结算：N 张认领共享一个事务（账户行锁一次拿放）。批内任一账单抛错
 * → 整批回滚并原样上抛（调用方回退逐张结算以隔离毒账单——失败分类语义
 * 归 processClaim/finishFailure，本用例不吞错）。
 */
export function createSettleClaimsBatchUseCase(env: SettleEnv) {
  return async function settleClaims(
    claims: readonly SettlementClaim[],
  ): Promise<SettleClaimResult[]> {
    if (claims.length === 0) return [];
    const settled = await env.store.transaction(async (tx) => {
      const out: {
        result: SettleClaimResult;
        settledUserId: number | null;
        usageDefect: Parameters<NonNullable<SettleEnv['onUsageDefect']>>[0] | null;
        claim: SettlementClaim;
      }[] = [];
      for (const claim of claims) {
        out.push({ ...(await settleOneInTx(env, tx, claim)), claim });
      }
      return out;
    });
    for (const row of settled) {
      if (row.result.outcome === 'settled' && row.settledUserId != null) {
        fireOnSettled(env, {
          requestId: row.claim.requestId,
          userId: row.settledUserId,
          receipt: row.claim.receipt ?? {},
          amount: row.result.amount,
          waived: row.result.waived,
        });
      }
      if (row.usageDefect != null) fireOnUsageDefect(env, row.usageDefect);
    }
    return settled.map((row) => row.result);
  };
}
