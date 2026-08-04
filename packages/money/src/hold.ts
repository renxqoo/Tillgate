import { COEFFICIENT_SCALE, PRICE_PER_MILLION } from './units.js';

/**
 * 预扣（billing hold）估算（requirements.md 4.7）：
 *   估算上限 = (估算输入 tokens × 输入价 + 默认输出上限 × 输出价) × 系数（缓存按全价保守估）
 *   hold = min(估算上限, 可用余额, HOLD_MAX)
 *
 * 资损防线（与 calcAmount 同口径）：所有输入先经 safe() 规范化
 *   （负数/NaN/Infinity → 0），确保异常输入（如 max_tokens=Infinity、配置错误）
 *   不会让估算炸裂成 Infinity/NaN 污染 hold 链路（NaN 写入 Redis INCRBY/DB 数值列会抛错或污染账本）。
 */

/** 规范化数值：非有限/负数 → 0（资损防御：绝不让异常输入算出非有限估算） */
function safe(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export interface HoldEstimateInput {
  estimatedInputTokens: number;
  /** 默认输出上限（请求带 max_tokens 时用其值） */
  maxOutputTokens: number;
  inputPrice: number;
  outputPrice: number;
  coefficientMilli: number;
}

export function estimateMaxCost(input: HoldEstimateInput): number {
  const estimatedInputTokens = safe(input.estimatedInputTokens);
  const maxOutputTokens = safe(input.maxOutputTokens);
  const inputPrice = safe(input.inputPrice);
  const outputPrice = safe(input.outputPrice);
  const coefficientMilli = safe(input.coefficientMilli);
  const base = estimatedInputTokens * inputPrice + maxOutputTokens * outputPrice;
  return Math.max(0, Math.round((base * coefficientMilli) / (PRICE_PER_MILLION * COEFFICIENT_SCALE)));
}

export function calcHold(estimate: number, availableBalance: number, holdMax: number): number {
  // estimate 可以为 0（safe 把负数/NaN 干掉了，但合法的 0 保留）
  const est = Number.isFinite(estimate) && estimate >= 0 ? estimate : 0;
  const bal = safe(availableBalance);
  const max = safe(holdMax);
  // estimate=0 时不拦截（极小请求，靠 worker 结算实际扣费）
  if (est === 0) return 0;
  return Math.min(est, bal, max);
}
