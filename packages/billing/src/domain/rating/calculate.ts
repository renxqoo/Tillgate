/**
 * 授权预扣额推导（纯函数）：候选链取最贵（fallback 更贵不得透支），再过单请求上限。
 *
 * 四道保守：输入按上界、单价取贵（缓存命中量未知）、候选取最贵、超限只拒绝不截断。
 * 免费口径（docs/free-by-price.md）：explicitlyFree = 候选链价格全零（组装方按价格
 * 推导，无平行标记可矛盾）→ 授权 0 元不校验余额；结算按价格实扣同样为 0。
 * 组装 estimateMaxCost 必须传 cacheWritePrice（贵价口径覆盖缓存写价——
 * Anthropic 写价 1.25×/2× 可超输入价）。
 */
import { Decimal } from '../money.js';
import { BillingErrors } from '../errors.js';
import { estimateMaxCost, requiredReservation } from './pricing.js';
import type { BillingQuote } from './types.js';

export interface FundingReservationPolicy {
  mode?: 'full' | 'fixed';
  amount?: string;
}

/**
 * 风险预估与实际冻结解耦：full 冻结完整预估；fixed 只冻结显式门槛。
 * 最终收费仍由收据实际金额决定，fixed 不是封顶或折扣。
 */
export function calculateFundingReservation(
  estimatedAmount: string,
  policy: FundingReservationPolicy = { mode: 'full' },
): Decimal {
  const estimated = new Decimal(estimatedAmount);
  if (!estimated.isFinite() || estimated.lt(0)) {
    throw BillingErrors.business('invalid_quote');
  }
  if ((policy.mode ?? 'full') === 'full') return estimated;
  const fixed = new Decimal(policy.amount ?? Number.NaN);
  if (!fixed.isFinite() || fixed.lte(0)) {
    throw BillingErrors.business('invalid_reservation_balance');
  }
  return estimated.isZero() ? estimated : fixed;
}

export function calculateRequired(quote: BillingQuote, reservationLimit: string): Decimal {
  if (quote.candidates.length === 0) throw BillingErrors.business('invalid_quote');
  // 免费链（价格全零，组装方推导）：授权 0 元、不校验余额
  if (quote.explicitlyFree) return new Decimal(0);

  let maximum = new Decimal(0);
  for (const candidate of quote.candidates) {
    const coefficient = new Decimal(candidate.coefficient);
    const prices = [
      new Decimal(candidate.inputPrice),
      new Decimal(candidate.outputPrice),
      new Decimal(candidate.cacheInputPrice),
      new Decimal(candidate.unitPrice ?? 0),
    ];
    if (!coefficient.isFinite() || coefficient.lte(0)) {
      throw BillingErrors.business('invalid_coefficient');
    }
    if (prices.some((price) => !price.isFinite() || price.lt(0))) {
      throw BillingErrors.business('invalid_quote');
    }
    const estimate = estimateMaxCost({
      estimatedInputTokens: candidate.inputTokenUpperBound,
      maxOutputTokens: quote.maxOutputTokens,
      inputPrice: candidate.inputPrice,
      cacheInputPrice: candidate.cacheInputPrice,
      // 缓存写价进贵价口径（缺省由 estimateMaxCost 回落输入价）
      cacheWritePrice: candidate.cacheWritePrice,
      outputPrice: candidate.outputPrice,
      unitPrice: candidate.unitPrice ?? '0',
      unitUpperBound: candidate.unitUpperBound ?? 0,
      coefficient,
    });
    if (estimate.gt(maximum)) maximum = estimate;
  }
  // 非免费链（explicitlyFree 缺失）算出零预扣 = 组装事故（价格全零未被推导为免费）——结构性拒绝
  if (maximum.lte(0)) throw BillingErrors.business('invalid_quote');
  return requiredReservation(maximum, reservationLimit);
}
