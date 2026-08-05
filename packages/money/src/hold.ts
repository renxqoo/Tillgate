import { Decimal } from 'decimal.js';
import { PRICE_PER_MILLION, toDecimal } from './units.js';

/**
 * 预扣（billing hold）估算（重构后：元 + decimal 全精度）：
 *   估算上限 = (估算输入 tokens × 输入价 + 默认输出上限 × 输出价) × 系数（缓存按全价保守估）
 *   hold = min(估算上限, 可用余额, HOLD_MAX)
 *
 * 资损防线：所有输入先经 safe() 规范化（负数/NaN/Infinity → 0），
 * 确保异常输入不会让估算炸裂成非有限值污染 hold 链路。
 */

/** 规范化数值：非有限/负数 → 0 */
function safe(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export interface HoldEstimateInput {
  estimatedInputTokens: number;
  /** 默认输出上限（请求带 max_tokens 时用其值） */
  maxOutputTokens: number;
  inputPrice: Decimal | string | number;
  outputPrice: Decimal | string | number;
  coefficient: Decimal | string | number;
}

/**
 * 估算请求费用上限（元，Decimal 全精度）。
 * 用于 gateway 同步预扣，返回值经 calcHold 夹到 min(estimate, balance, HOLD_MAX)。
 */
export function estimateMaxCost(input: HoldEstimateInput): Decimal {
  const estimatedInputTokens = safe(input.estimatedInputTokens);
  const maxOutputTokens = safe(input.maxOutputTokens);
  const inputPrice = toDecimal(input.inputPrice);
  const outputPrice = toDecimal(input.outputPrice);
  const coefficient = toDecimal(input.coefficient);
  const coeff = coefficient.lte(0) ? new Decimal(0) : coefficient;
  const base = inputPrice.times(estimatedInputTokens).plus(outputPrice.times(maxOutputTokens));
  const cost = base.div(PRICE_PER_MILLION).times(coeff);
  return cost.lt(0) ? new Decimal(0) : cost;
}

/**
 * 预扣金额：min(估算, 余额, HOLD_MAX)。
 * @param estimate 估算费用（Decimal 或 string/number）
 * @param availableBalance 可用余额（元）
 * @param holdMax 单次预扣上限（元）
 * @returns Decimal 预扣金额（元）；estimate=0 时返回 0（极小请求不拦截，靠 worker 结算实际扣费）
 */
export function calcHold(
  estimate: Decimal | string | number,
  availableBalance: Decimal | string | number,
  holdMax: Decimal | string | number,
): Decimal {
  const est = toDecimal(estimate);
  const bal = toDecimal(availableBalance);
  const max = toDecimal(holdMax);
  // estimate=0 时不拦截（极小请求，靠 worker 结算实际扣费）
  if (est.isZero()) return new Decimal(0);
  // 任一为负/非有限 → 0（防御：不污染 DB 扣减）
  if (est.lte(0) || bal.lte(0) || max.lte(0)) return new Decimal(0);
  return Decimal.min(est, bal, max);
}
