/** 升档折算纯函数（S3 抽取）：剩余价值与补差价的唯一公式。 */
import { Decimal, toDecimal } from '@ai-gateway/wallet/metering';

export interface QuotaSnapshot {
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
}

/** 剩余额度 = 总额度 − 已用 − 在途。 */
export function remainingQuota(snapshot: QuotaSnapshot): Decimal {
  return toDecimal(snapshot.quotaAmount)
    .minus(toDecimal(snapshot.usedAmount))
    .minus(toDecimal(snapshot.reservedAmount));
}

/**
 * 剩余价值 = 购买总价 × 剩余额度/总额度（线性折旧）。
 * 总额度 ≤ 0 → 0（除零防御；脏数据不得放大剩余价值）。
 */
export function remainingValue(snapshot: QuotaSnapshot & { price: string }): Decimal {
  const total = toDecimal(snapshot.quotaAmount);
  if (total.lte(0)) return new Decimal(0);
  return toDecimal(snapshot.price).times(remainingQuota(snapshot)).div(total);
}

/** 补差价 = max(0, 新总价 − 剩余价值)；≤ 0 即免费升级。 */
export function changeDiff(newTotalPrice: string, remaining: Decimal | string): Decimal {
  const diff = toDecimal(newTotalPrice).minus(toDecimal(remaining));
  return diff.gt(0) ? diff : new Decimal(0);
}
