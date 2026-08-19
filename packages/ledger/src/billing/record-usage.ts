/**
 * billing/record-usage：usage_logs 落库（结算事务内的投影写，自 settle.ts 抽出）。
 *
 * usage_logs 不是资金流水——资金事实在 wallet statement（wallet_legs）；
 * 此表承载计量/计价快照与归属维度（billedBy / planAmount / paygAmount /
 * subscriptionId / estimated），供报表与限额口径（每日上限按 amount 统计）。
 * requestId 唯一约束幂等：认领机制保证唯一写入路径，冲突命中 = 不变量红灯。
 */
import { usageLogs } from '@ai-gateway/db/schema';
import { toDecimal } from '@ai-gateway/wallet/metering';
import { BillingInvariantError } from '../platform/errors.js';
import type { DomainTx } from '../platform/operations.js';
import type { UsageReceipt } from '../rating/types.js';

export async function recordUsage(
  tx: DomainTx,
  billing: { userId: number; subscriptionId: number | null; channelId: number | null },
  data: UsageReceipt,
  amounts: { calculatedAmount: string; upstreamCost: string },
): Promise<void> {
  const billedBy: 'plan' | 'payg' = billing.subscriptionId != null ? 'plan' : 'payg';
  const planCharge = billing.subscriptionId != null ? amounts.calculatedAmount : '0';
  const paygCharge = billing.subscriptionId == null ? amounts.calculatedAmount : '0';
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
      units: data.usage.units ?? 0,
      inputPrice: data.inputPrice,
      outputPrice: data.outputPrice,
      cacheInputPrice: data.cacheInputPrice,
      unitPrice: data.unitPrice ?? '0',
      coefficient: toDecimal(data.coefficient).toFixed(3),
      amount: amounts.calculatedAmount,
      calculatedAmount: amounts.calculatedAmount,
      upstreamCost: amounts.upstreamCost,
      planAmount: planCharge,
      paygAmount: paygCharge,
      billedBy,
      subscriptionId:
        billing.subscriptionId != null && toDecimal(planCharge).gt(0) ? billing.subscriptionId : null,
      durationMs: data.durationMs,
      status: 0,
      stream: data.stream,
      streamAborted: data.streamAborted,
      estimated: data.usage.estimated,
      estimateReason: data.usage.estimated ? (data.estimatedFor ?? null) : null,
    })
    .onConflictDoNothing({ target: usageLogs.requestId })
    .returning({ id: usageLogs.id });
  if (inserted.length === 0) throw new BillingInvariantError('billing_invariant_usage_conflict');
}
