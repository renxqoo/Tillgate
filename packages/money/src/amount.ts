import { COEFFICIENT_SCALE, PRICE_PER_MILLION } from './units.js';

/**
 * 计费公式（核心，先乘后除一次舍入）：
 *
 *   uncached = inputTokens - cachedInputTokens      （inputTokens 为总输入，含缓存命中）
 *   base = uncached×输入价 + cachedInputTokens×缓存价 + 输出×输出价   （厘·百万⁻¹ 量纲）
 *   amount = round( base × 系数毫 / (百万 × 系数倍率) )              （厘）
 *
 * 全程整数运算（< 2^53 安全）：10M tokens × 1e5 厘/百万 × 1e3 = 1e15 < 9.0e15
 */
export interface AmountInput {
  /** 输入总 tokens（含缓存命中） */
  inputTokens: number;
  /** 缓存命中输入 tokens（≤ inputTokens） */
  cachedInputTokens: number;
  outputTokens: number;
  /** 厘/百万 token（官方价） */
  inputPrice: number;
  cacheInputPrice: number;
  outputPrice: number;
  /** 费率卡系数 × 1000（1.0 → 1000） */
  coefficientMilli: number;
}

export function calcAmount(input: AmountInput): number {
  const uncached = Math.max(0, input.inputTokens - input.cachedInputTokens);
  const base =
    uncached * input.inputPrice +
    input.cachedInputTokens * input.cacheInputPrice +
    input.outputTokens * input.outputPrice;
  const denominator = PRICE_PER_MILLION * COEFFICIENT_SCALE;
  return Math.round((base * input.coefficientMilli) / denominator);
}

/** BigInt 精确实现（测试对照用：验证 number 路径在量级内与精确计算一致） */
export function calcAmountExact(input: AmountInput): bigint {
  const uncached = BigInt(Math.max(0, input.inputTokens - input.cachedInputTokens));
  const base =
    uncached * BigInt(input.inputPrice) +
    BigInt(input.cachedInputTokens) * BigInt(input.cacheInputPrice) +
    BigInt(input.outputTokens) * BigInt(input.outputPrice);
  const denominator = BigInt(PRICE_PER_MILLION) * BigInt(COEFFICIENT_SCALE);
  const numerator = base * BigInt(input.coefficientMilli);
  const half = numerator % denominator >= denominator / 2n ? 1n : 0n;
  return numerator / denominator + half;
}
