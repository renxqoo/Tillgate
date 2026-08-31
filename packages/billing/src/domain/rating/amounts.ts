/**
 * 结算金额双口径（纯函数）：
 *   calculated   用户侧实扣 = 真实 usage × 价格快照 × 系数（Decimal 全精度）
 *   upstreamCost 渠道侧成本 = 成本轴快照（receipt.costPrices ?? 用户价轴——继承口径
 *   由上游物化）、系数恒 1，渠道进货额度按此扣减（docs/channel-cost-pricing.md）
 * 两个口径共用 calcAmount 的全部防御（负值/NaN/Infinity → 0、cached ≤ input、负价钳 0）。
 */
import type { Decimal } from '../money.js';
import { calcAmount, type AmountInput } from './pricing.js';
import type { UsageReceipt } from './types.js';

export interface SettleAmounts {
  calculated: Decimal;
  calculatedAmount: string;
  upstreamCost: string;
}

export function computeAmounts(data: UsageReceipt): SettleAmounts {
  const cost = data.costPrices;
  const base: Omit<AmountInput, 'coefficient'> = {
    inputTokens: data.usage.inputTokens,
    cachedInputTokens: data.usage.cachedInputTokens,
    outputTokens: data.usage.outputTokens,
    cacheWriteTokens: data.usage.cacheWriteTokens ?? 0,
    inputPrice: data.inputPrice,
    cacheInputPrice: data.cacheInputPrice,
    cacheWritePrice: data.cacheWritePrice ?? '0',
    outputPrice: data.outputPrice,
    units: data.usage.units ?? 0,
    unitPrice: data.unitPrice ?? '0',
  };
  const calculated = calcAmount({ ...base, coefficient: data.coefficient });
  // 成本口径换轴：有渠道成本快照走成本五轴；缺省沿用用户价轴（继承映射官方价）
  const upstream = calcAmount({
    ...(cost == null
      ? base
      : {
          ...base,
          inputPrice: cost.inputPrice,
          cacheInputPrice: cost.cacheInputPrice,
          cacheWritePrice: cost.cacheWritePrice,
          outputPrice: cost.outputPrice,
          unitPrice: cost.unitPrice,
        }),
    coefficient: '1',
  });
  return {
    calculated,
    calculatedAmount: calculated.toString(),
    upstreamCost: upstream.toString(),
  };
}
