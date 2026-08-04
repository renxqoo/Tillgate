import { COEFFICIENT_SCALE, PRICE_PER_MILLION } from './units.js';

/**
 * 预扣（billing hold）估算（requirements.md 4.7）：
 *   估算上限 = (估算输入 tokens × 输入价 + 默认输出上限 × 输出价) × 系数（缓存按全价保守估）
 *   hold = min(估算上限, 可用余额, HOLD_MAX)
 */

export interface HoldEstimateInput {
  estimatedInputTokens: number;
  /** 默认输出上限（请求带 max_tokens 时用其值） */
  maxOutputTokens: number;
  inputPrice: number;
  outputPrice: number;
  coefficientMilli: number;
}

export function estimateMaxCost(input: HoldEstimateInput): number {
  const base =
    input.estimatedInputTokens * input.inputPrice + input.maxOutputTokens * input.outputPrice;
  return Math.round((base * input.coefficientMilli) / (PRICE_PER_MILLION * COEFFICIENT_SCALE));
}

export function calcHold(estimate: number, availableBalance: number, holdMax: number): number {
  return Math.min(estimate, availableBalance, holdMax);
}
