import { COEFFICIENT_SCALE, PRICE_PER_MILLION } from './units.js';

/**
 * 计费公式（核心，先乘后除一次舍入）：
 *
 *   uncached = inputTokens - cachedInputTokens      （inputTokens 为总输入，含缓存命中）
 *   base = uncached×输入价 + cachedInputTokens×缓存价 + 输出×输出价   （厘·百万⁻¹ 量纲）
 *   amount = round( base × 系数毫 / (百万 × 系数倍率) )              （厘）
 *
 * 全程整数运算（< 2^53 安全）：10M tokens × 1e5 厘/百万 × 1e3 = 1e15 < 9.0e15
 *
 * 资损防线：所有输入先经 safe() 规范化（负数/NaN/Infinity → 0，cached 夹到 ≤ input），
 * 确保任何异常上游响应或配置错误都不会算出负金额（反向收费/白嫖）。
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

/** 规范化数值：非有限/负数 → 0（资损防御：绝不让异常输入算出负金额） */
function safe(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function calcAmount(input: AmountInput): number {
  const inputTokens = safe(input.inputTokens);
  const outputTokens = safe(input.outputTokens);
  const inputPrice = safe(input.inputPrice);
  const cacheInputPrice = safe(input.cacheInputPrice);
  const outputPrice = safe(input.outputPrice);
  const coefficientMilli = safe(input.coefficientMilli);
  // cached 夹到 ≤ inputTokens（防异常上游返回 cached > total 导致负未缓存 + 超大缓存双计）
  const cachedInputTokens = Math.min(safe(input.cachedInputTokens), inputTokens);
  const uncached = inputTokens - cachedInputTokens;
  const base =
    uncached * inputPrice + cachedInputTokens * cacheInputPrice + outputTokens * outputPrice;
  const denominator = PRICE_PER_MILLION * COEFFICIENT_SCALE;
  return Math.max(0, Math.round((base * coefficientMilli) / denominator));
}

/** BigInt 精确实现（测试对照用：验证 number 路径在量级内与精确计算一致） */
export function calcAmountExact(input: AmountInput): bigint {
  const inputTokens = safe(input.inputTokens);
  const cachedInputTokens = Math.min(safe(input.cachedInputTokens), inputTokens);
  const uncached = BigInt(inputTokens - cachedInputTokens);
  const base =
    uncached * BigInt(safe(input.inputPrice)) +
    BigInt(cachedInputTokens) * BigInt(safe(input.cacheInputPrice)) +
    BigInt(safe(input.outputTokens)) * BigInt(safe(input.outputPrice));
  const denominator = BigInt(PRICE_PER_MILLION) * BigInt(COEFFICIENT_SCALE);
  const numerator = base * BigInt(safe(input.coefficientMilli));
  const half = numerator % denominator >= denominator / 2n ? 1n : 0n;
  return numerator / denominator + half;
}
