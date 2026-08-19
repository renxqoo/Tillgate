/**
 * rating/amounts：结算金额推导（纯函数，无 DB）。
 *
 *   calculated   用户侧实扣 = calcAmount（真实 usage × 价格快照 × 系数，Decimal 全精度）
 *   upstreamCost 渠道侧成本 = 官方价口径（系数=1），渠道进货额度按此扣减
 * 自 billing/settle/compute-amounts.ts 上移（S2 纯迁移，行为零变更）。
 */
import { Decimal, calcAmount, toDecimal, toStorage } from '@ai-gateway/wallet/metering';
import type { UsageReceipt } from './types.js';

export interface SettleAmounts {
  calculated: Decimal;
  calculatedAmount: string;
  upstreamCost: string;
}

export function computeAmounts(data: UsageReceipt): SettleAmounts {
  const calculated = calcAmount({
    inputTokens: data.usage.inputTokens,
    cachedInputTokens: data.usage.cachedInputTokens,
    outputTokens: data.usage.outputTokens,
    inputPrice: data.inputPrice,
    cacheInputPrice: data.cacheInputPrice,
    outputPrice: data.outputPrice,
    units: data.usage.units ?? 0,
    unitPrice: data.unitPrice ?? '0',
    coefficient: data.coefficient,
  });
  const calculatedAmount = toStorage(calculated);

  const inputTokens = Math.max(0, data.usage.inputTokens);
  const cached = Math.min(Math.max(0, data.usage.cachedInputTokens), inputTokens);
  const uncached = inputTokens - cached;
  const tokenBase = toDecimal(data.inputPrice)
    .times(uncached)
    .plus(toDecimal(data.cacheInputPrice).times(cached))
    .plus(toDecimal(data.outputPrice).times(Math.max(0, data.usage.outputTokens)));
  const unitPrice = toDecimal(data.unitPrice ?? 0);
  const unitBase = unitPrice.lt(0)
    ? new Decimal(0)
    : unitPrice.times(Math.max(0, data.usage.units ?? 0));
  const upstreamCostDec = tokenBase.div(1_000_000).plus(unitBase);
  const upstreamCost = toStorage(upstreamCostDec.lt(0) ? new Decimal(0) : upstreamCostDec);

  return { calculated, calculatedAmount, upstreamCost };
}
