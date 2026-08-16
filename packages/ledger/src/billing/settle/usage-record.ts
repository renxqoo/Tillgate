import { sql } from 'drizzle-orm';
import { toDecimal } from '@ai-gateway/money';
import { transactions, usageLogs, userSubscriptions } from '@ai-gateway/db/schema';
import { BillingInvariantError } from '../errors.js';
import type { DbTx, ReservationProjectionRow, UsageReceipt } from '../types.js';
import type { ChargeOutcome } from './charge.js';

/**
 * 账单落库（拆自 settleClaim）：
 *
 *   usage_logs     用量明细（requestId 唯一约束幂等；estimated + estimate_reason
 *                  估算扣款一等字段——管理端「估算」标数据源）
 *   transactions   余额扣费流水（普通 Key 非 0 元；ref 唯一约束幂等）
 *   subscription   套餐已用额度累加（封顶守卫在 WHERE：used + planCharge ≤ quota）
 */
export async function recordUsage(
  tx: DbTx,
  billing: ReservationProjectionRow,
  data: UsageReceipt,
  amounts: { calculatedAmount: string; upstreamCost: string },
  charge: ChargeOutcome,
): Promise<void> {
  const billedBy: 'plan' | 'payg' = billing.subscriptionId != null ? 'plan' : 'payg';
  const inserted = await tx
    .insert(usageLogs)
    .values({
      requestId: data.requestId,
      userId: billing.userId,
      appId: data.appId,
      apiKeyId: data.apiKeyId,
      credentialType: data.credentialType,
      externalModel: data.externalModel,
      realModel: data.realModel,
      channelId: billing.channelId,
      inputTokens: data.usage.inputTokens,
      cachedInputTokens: data.usage.cachedInputTokens,
      outputTokens: data.usage.outputTokens,
      inputPrice: data.inputPrice,
      outputPrice: data.outputPrice,
      cacheInputPrice: data.cacheInputPrice,
      coefficient: toDecimal(data.coefficient).toFixed(3),
      amount: amounts.calculatedAmount,
      calculatedAmount: amounts.calculatedAmount,
      upstreamCost: amounts.upstreamCost,
      planAmount: charge.planCharge.toString(),
      paygAmount: charge.paygCharge.toString(),
      billedBy,
      subscriptionId: charge.planCharge.gt(0) ? billing.subscriptionId : null,
      durationMs: data.durationMs,
      status: 0,
      stream: data.stream,
      streamAborted: data.streamAborted,
      estimated: data.usage.estimated,
      // 估算标记合取收口：reason 只属于 estimated=true 的行（validateReceipt 只挡了
      // estimated ⇒ 必须有归属；反向 estimatedFor 挂在非估算收据上是网关 bug，不落库）
      estimateReason: data.usage.estimated ? (data.estimatedFor ?? null) : null,
    })
    .onConflictDoNothing({ target: usageLogs.requestId })
    .returning({ id: usageLogs.id });
  if (inserted.length === 0) throw new BillingInvariantError('billing_invariant_usage_conflict');

  // 余额扣费流水（普通 Key）：0 元不写；幂等靠 transactions_consume_ref_uq（ref_type=usage_logs）。
  if (billing.subscriptionId == null && charge.balanceBefore != null && charge.balanceAfter != null) {
    await tx
      .insert(transactions)
      .values({
        userId: billing.userId,
        type: 'consume',
        amount: `-${amounts.calculatedAmount}`,
        balanceBefore: charge.balanceBefore,
        balanceAfter: charge.balanceAfter,
        refType: 'usage_logs',
        refId: data.requestId,
        remark: 'usage consume',
      })
      .onConflictDoNothing();
  }

  // 套餐已用额度累加（封顶：used + planCharge ≤ quota，硬闸保证不扣负）。
  if (charge.planCharge.gt(0)) {
    const subCharged = await tx
      .update(userSubscriptions)
      .set({
        usedAmount: sql`${userSubscriptions.usedAmount} + ${charge.planCharge.toString()}::numeric`,
      })
      .where(
        sql`${userSubscriptions.id} = ${billing.subscriptionId}
            and ${userSubscriptions.quotaAmount} - ${userSubscriptions.usedAmount} >= ${charge.planCharge.toString()}::numeric`,
      )
      .returning({ id: userSubscriptions.id });
    if (subCharged.length === 0) throw new BillingInvariantError('subscription_quota_invariant');
  }
}
