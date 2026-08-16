import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests, usageLogs } from '@ai-gateway/db/schema';
import { BillingInvariantError, ReceiptUserMismatchError } from '../errors.js';
import { isAttributedEstimate, type SettleClaimResult, type SettlementClaim } from '../types.js';
import { computeAmounts } from './compute-amounts.js';
import { applyCharge } from './charge.js';
import { recordUsage } from './usage-record.js';
import { deductChannelBudget, releaseChannelExposure } from './channel-closeout.js';

export { backfillTpm } from './tpm-backfill.js';

/** 事务回调的返回契约：结局 + 已扣金额 + 是否触发渠道熔断（闭包可变状态的替代） */
interface SettleOutcome {
  outcome: SettleClaimResult['outcome'];
  amount: string;
  channelCircuitBroken: boolean;
}

/**
 * 结算一个已持久化收据（编排，事务边界不变）。调用方不能直接指定扣费主体或
 * 可捕获金额：billing_requests 的用户、预扣和 settlement_pending 状态才是授权事实。
 *
 *   认领复验（claim 三元组 + 租约）→ 幂等回查（already_settled）→ 归属校验
 *   → applyCharge（扣费）→ recordUsage（账单落库）→ releaseChannelExposure
 *   → billing_requests → settled（认领复验）→ deductChannelBudget（进货扣减/熔断）
 *
 * 信用模型：无「calculated > 预估 → dead」的金额不变量——reserved_amount 只是
 * 并发熔断的在途敞口估算，结算无条件按实际金额扣费，balance 可降至
 * -credit_limit（DB 约束兜底，触底 → invariant_violation → dead 人工）。
 *
 * 事务回调直接返回 SettleOutcome（不用闭包可变状态）：任何一步抛错即整体回滚，
 * 结局只有「settled / already_settled / claim_lost」三种。
 */
export async function settleClaim(db: Db, claim: SettlementClaim): Promise<SettleClaimResult> {
  const data = claim.receipt;
  const { calculated, calculatedAmount, upstreamCost } = computeAmounts(data);

  const result = await db.transaction(async (tx): Promise<SettleOutcome> => {
    const billing = await tx.query.billingRequests.findFirst({
      where: and(
        eq(billingRequests.requestId, data.requestId),
        eq(billingRequests.status, 'processing'),
        eq(billingRequests.claimToken, claim.claimToken),
        eq(billingRequests.claimOwner, claim.ownerId),
        eq(billingRequests.revision, claim.revision),
        gt(billingRequests.claimUntil, sql`clock_timestamp()`),
      ),
      columns: {
        userId: true,
        reservedAmount: true,
        planReservedAmount: true,
        subscriptionId: true,
        channelId: true,
        channelReservedAmount: true,
      },
    });
    if (!billing) {
      // 认领失效（并发对手已结算/认领过期）：usage_logs 已有记录 → already_settled 幂等返回
      const existingUsage = await tx.query.usageLogs.findFirst({
        where: eq(usageLogs.requestId, data.requestId),
        columns: { amount: true },
      });
      if (existingUsage) {
        return { outcome: 'already_settled', amount: existingUsage.amount, channelCircuitBroken: false };
      }
      return { outcome: 'claim_lost', amount: '0', channelCircuitBroken: false };
    }
    if (billing.userId !== data.userId) throw new ReceiptUserMismatchError();
    // G1 精细化：估算 usage 只允许归属「用户取消 ∪ 完成缺 usage」（与 validateReceipt 同判定）
    if (data.usage.estimated && !isAttributedEstimate(data)) {
      throw new BillingInvariantError('billing_invariant_estimated_usage');
    }
    // 渠道维度单一事实：收据归属渠道（进货扣减维度）必须与账单预留渠道（敞口
    // 释放维度）一致。网关侧两者同源构造；不一致即网关回归——进货成本会扣错
    // 渠道、熔断错渠道，红灯 dead 人工，不允许静默漂移。
    if (
      billing.channelId != null &&
      data.channelId != null &&
      billing.channelId !== data.channelId
    ) {
      throw new BillingInvariantError('billing_channel_mismatch');
    }

    const charge = await applyCharge(tx, billing, calculated, calculatedAmount);
    await recordUsage(tx, billing, data, { calculatedAmount, upstreamCost }, charge);
    await releaseChannelExposure(tx, billing);

    const finalized = await tx
      .update(billingRequests)
      .set({
        status: 'settled',
        revision: sql`${billingRequests.revision} + 1`,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
        settledAt: sql`clock_timestamp()`,
        nextSettlementAt: null,
        lastError: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(billingRequests.requestId, data.requestId),
          eq(billingRequests.status, 'processing'),
          eq(billingRequests.claimToken, claim.claimToken),
          eq(billingRequests.claimOwner, claim.ownerId),
          eq(billingRequests.revision, claim.revision),
          gt(billingRequests.claimUntil, sql`clock_timestamp()`),
        ),
      )
      .returning({ requestId: billingRequests.requestId });
    if (finalized.length === 0) throw new BillingInvariantError('billing_state_changed_during_settlement');

    const channelCircuitBroken = await deductChannelBudget(tx, data, upstreamCost);
    return { outcome: 'settled', amount: calculatedAmount, channelCircuitBroken };
  });

  return {
    outcome: result.outcome,
    settled: result.outcome === 'settled',
    amount: result.amount,
    calculatedAmount,
    channelCircuitBroken: result.channelCircuitBroken,
  };
}
