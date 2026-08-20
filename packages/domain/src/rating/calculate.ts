/**
 * 授权预扣额推导（纯函数）：候选链取最贵（fallback 更贵不得透支），再过单请求上限。
 *
 * 四道保守：输入按上界、单价取贵（缓存命中量未知）、候选取最贵、超限只拒绝不截断。
 * R6 免费口径一致性：explicitlyFree 是「授权 0 元、不校验余额」的开关，
 * 若候选价格非全零，结算会按价格实扣——授权与结算两套口径结构性拒绝。
 */
import { Decimal } from '../wallet/money.js';
import { BillingConfigurationError } from './errors.js';
import { estimateMaxCost, requiredReservation, ReservationError } from './pricing.js';
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
    throw new BillingConfigurationError('invalid_quote');
  }
  if ((policy.mode ?? 'full') === 'full') return estimated;
  const fixed = new Decimal(policy.amount ?? Number.NaN);
  if (!fixed.isFinite() || fixed.lte(0)) {
    throw new BillingConfigurationError('invalid_reservation_balance');
  }
  return estimated.isZero() ? estimated : fixed;
}

export function calculateRequired(quote: BillingQuote, reservationLimit: string): Decimal {
  if (quote.candidates.length === 0) throw new BillingConfigurationError('invalid_quote');
  if (quote.explicitlyFree) {
    const charged = quote.candidates.some((candidate) => {
      const prices = [
        candidate.inputPrice,
        candidate.outputPrice,
        candidate.cacheInputPrice,
        candidate.unitPrice ?? '0',
      ];
      return prices.some((price) => new Decimal(price).gt(0));
    });
    if (charged) throw new BillingConfigurationError('invalid_quote');
    return new Decimal(0);
  }

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
      throw new BillingConfigurationError('invalid_coefficient');
    }
    if (prices.some((price) => !price.isFinite() || price.lt(0))) {
      throw new BillingConfigurationError('invalid_quote');
    }
    const estimate = estimateMaxCost({
      estimatedInputTokens: candidate.inputTokenUpperBound,
      maxOutputTokens: quote.maxOutputTokens,
      inputPrice: candidate.inputPrice,
      cacheInputPrice: candidate.cacheInputPrice,
      outputPrice: candidate.outputPrice,
      unitPrice: candidate.unitPrice ?? '0',
      unitUpperBound: candidate.unitUpperBound ?? 0,
      coefficient,
    });
    if (estimate.gt(maximum)) maximum = estimate;
  }
  // 零价但未声明免费 = 配置事故（免费额度印刷机）——结构性拒绝
  if (maximum.lte(0)) throw new BillingConfigurationError('invalid_quote');
  try {
    return requiredReservation(maximum, reservationLimit);
  } catch (error) {
    if (error instanceof ReservationError && error.code === 'reservation_limit_exceeded') {
      throw new BillingConfigurationError('reservation_limit_exceeded');
    }
    throw new BillingConfigurationError('invalid_quote');
  }
}
