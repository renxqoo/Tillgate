/**
 * billing/settle（S5 重写）：结算编排——钱包之上。
 *
 *   认领复验（claim 三元组 + 租约）→ 幂等回查 → 归属校验 → 金额（rating.computeAmounts）
 *   → PAYG：wallet.settle（actual ≤ hold）/ settleOverHold §4 补充授权（actual > hold）
 *   → 订阅：subscription.settleQuota（释放预占 + 核销，溢出 = invariant → dead）
 *   → usage_logs 落库（record-usage.ts，投影）→ 渠道收尾（releaseExposure +
 *     deductBudget 熔断）→ CAS settled
 *
 * 本文件只保留事务编排（原子边界 = 理解单元）：钱包动作、CAS 收尾与失败回滚
 * 必须顺序可见。可分离的关注点抽为具名单元——投影写 record-usage.ts、
 * §4 资金模式 settleOverHold（同文件，控制流属事务本体）。
 * wallet 契约不动：settle ≤ hold 由内核保证；「实际 > 预留」用补充授权模式表达
 * （AI 计费特性），statement 呈现两笔结算（plan §11 Q1 拍板）。
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests, usageLogs } from '@ai-gateway/db/schema';
import type { Wallet } from '@ai-gateway/wallet';
import { toDecimal } from '@ai-gateway/wallet/metering';
import { computeAmounts } from '../rating/amounts.js';
import { settleQuota } from '../subscription/quota.js';
import { deductBudget, releaseExposure } from '../channel-budget/closeout.js';
import { BillingInvariantError, ReceiptUserMismatchError } from '../platform/errors.js';
import type { DomainTx } from '../platform/operations.js';
import type { SettleClaimResult, SettlementClaim } from './types.js';
import { isAttributedEstimate } from '../rating/types.js';
import { recordUsage } from './record-usage.js';

interface SettleOutcome {
  outcome: SettleClaimResult['outcome'];
  amount: string;
  channelCircuitBroken: boolean;
}

export async function settleBillingClaim(
  db: Db,
  wallet: Wallet,
  claim: SettlementClaim,
): Promise<SettleClaimResult> {
  const data = claim.receipt;
  const { calculatedAmount, upstreamCost } = computeAmounts(data);

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
      // 认领失效：usage_logs 已有记录 → already_settled 幂等返回
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
    // G1：估算 usage 只允许归属「用户取消 ∪ 完成缺 usage」
    if (data.usage.estimated && !isAttributedEstimate(data)) {
      throw new BillingInvariantError('billing_invariant_estimated_usage');
    }
    // 渠道维度单一事实：收据渠道必须与账单预留渠道一致，不一致即网关回归 → dead
    if (
      billing.channelId != null &&
      data.channelId != null &&
      billing.channelId !== data.channelId
    ) {
      throw new BillingInvariantError('billing_channel_mismatch');
    }

    if (billing.subscriptionId != null) {
      // 订阅来源：释放预占 + 核销实际消费（守卫单语句；溢出 = invariant → dead 人工）
      await settleQuota(tx, {
        subscriptionId: billing.subscriptionId,
        reserved: billing.planReservedAmount ?? '0',
        consumed: calculatedAmount,
      });
    } else {
      // PAYG：结算即收入确认；actual vs hold 双分支
      const hold = toDecimal(billing.reservedAmount);
      const actual = toDecimal(calculatedAmount);
      if (actual.lte(hold)) {
        await wallet.settle({
          refType: 'billing',
          refId: data.requestId,
          amount: calculatedAmount,
          memo: `billing settle ${data.requestId}`,
          tx: tx as unknown as Parameters<Wallet['settle']>[0]['tx'],
        });
      } else {
        await settleOverHold(wallet, tx, {
          userId: billing.userId,
          requestId: data.requestId,
          hold: billing.reservedAmount,
          delta: actual.minus(hold).toString(),
        });
      }
    }

    await recordUsage(tx, billing, data, { calculatedAmount, upstreamCost });
    await releaseExposure(tx, {
      channelId: billing.channelId,
      channelReservedAmount: billing.channelReservedAmount,
    });

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

    const channelCircuitBroken = await deductBudget(tx, data.channelId, upstreamCost);
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

/**
 * §4 补充授权结算（actual > hold）：同事务补押差价并结算，再结清原单——
 * 总扣款 = hold + delta = actual 精确；可用额守卫含授信，不通过整体拒绝
 * （等价旧信用地板）。statement 呈现两笔结算（plan §11 Q1 拍板）。
 */
async function settleOverHold(
  wallet: Wallet,
  tx: DomainTx,
  input: { userId: number; requestId: string; hold: string; delta: string },
): Promise<void> {
  await wallet.authorize({
    userId: input.userId,
    amount: input.delta,
    refType: 'billing',
    refId: `${input.requestId}#over`,
    memo: `billing over-hold ${input.requestId}`,
    tx: tx as unknown as Parameters<Wallet['authorize']>[0]['tx'],
  });
  await wallet.settle({
    refType: 'billing',
    refId: `${input.requestId}#over`,
    amount: input.delta,
    tx: tx as unknown as Parameters<Wallet['settle']>[0]['tx'],
  });
  await wallet.settle({
    refType: 'billing',
    refId: input.requestId,
    amount: input.hold,
    tx: tx as unknown as Parameters<Wallet['settle']>[0]['tx'],
  });
}
