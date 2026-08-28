import { extractTextFeatures } from '@tillgate/ai';

/**
 * 缺 usage 的实扣估算：ai 包只公开特征四计数器（充分统计量），本层用
 * 特征四计数器 + 校准系数（装配可调）作为
 * input/output 的实扣口径——「估算实扣向精确收敛」，字节保守上界（output-cap.ts）
 * 只作预扣敞口不入实扣。输出侧估算的数据源 = 流终态 success.outputFeatures。
 */

export interface EstimateWeights {
  cjkTokensPerChar: number;
  tokensPerWord: number;
  tokensPerNumber: number;
  tokensPerSymbol: number;
}

/** 文本 → token 估算（特征加权和，向上取整；空文本 0） */
export function estimateTokensFromText(text: string, weights: EstimateWeights): number {
  if (!text) return 0;
  const f = extractTextFeatures(text);
  const raw =
    f.cjkChars * weights.cjkTokensPerChar +
    f.wordSegments * weights.tokensPerWord +
    f.numberSegments * weights.tokensPerNumber +
    f.symbolCount * weights.tokensPerSymbol;
  return Math.ceil(raw);
}

/** 特征四计数器 → token 估算（流终态 outputFeatures 直供，无文本现场） */
export function estimateTokensFromFeatures(
  features: { cjkChars: number; wordSegments: number; numberSegments: number; symbolCount: number },
  weights: EstimateWeights,
): number {
  const raw =
    features.cjkChars * weights.cjkTokensPerChar +
    features.wordSegments * weights.tokensPerWord +
    features.numberSegments * weights.tokensPerNumber +
    features.symbolCount * weights.tokensPerSymbol;
  return Math.ceil(raw);
}

/** 请求体 → input token 实扣估算（序列化文本过特征估算；序列化失败兜底 0） */
export function estimateInputTokensOfBody(body: unknown, weights: EstimateWeights): number {
  try {
    return estimateTokensFromText(JSON.stringify(body) ?? '', weights);
  } catch {
    return 0;
  }
}
