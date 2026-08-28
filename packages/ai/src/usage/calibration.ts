/**
 * token 估算固定配置（单一真相，数据驱动，按「供应商+模型」为主粒度）。
 *
 * 权重按「字符类别」而非单一 charPerToken：实测（2026-08）
 * 各供应商 tokenizer 对中文约 1.5 字/token、英文约 0.9 词/token，与「1 字=1 token / 1 词=1 token」
 * 的直觉常数偏差显著。
 *
 * 三层结构（后者覆盖前者，全部为代码内固定值，调整需改代码发版）：
 *   defaults + tokensPerByte      全局兜底（新模型/无配置时）
 *   providers[provider]           供应商级（同供应商 tokenizer 共享）
 *   models["provider:model"]      供应商+模型级（主粒度，每模型一套）
 *
 * 注意：估算值只参与 TPM 预占 / 预扣敞口 / 非计费诊断 / 用户取消结算，不替代真实 usage 结算。
 */

/** 文本 token 权重（token / 字符 或 token / 段）。 */
export interface TextTokenWeights {
  /** CJK（Han/假名/谚文）每字 token 数。实测 ~0.7（1.5 字/token）。 */
  cjk: number;
  /** 拉丁字母连续段（单词）每段 token 数。实测 ~1.1。 */
  word: number;
  /** 数字连续段每段 token 数。默认 1.0。 */
  number: number;
  /** 其他非空白符号（标点/emoji）每个 token 数。默认 1.0。 */
  symbol: number;
}

/** 供应商级 / 供应商+模型级 的校准项（权重为相对继承链的部分覆盖）。 */
export interface ProviderCalibration {
  weights?: Partial<TextTokenWeights>;
  /**
   * 输入 template 固定偏移（token）：供应商注入的 system 指令 / 特殊 token / 对话格式开销。
   * 实测最大偏差源——DeepSeek ~70、MiniMax ~160、Cohere ~0。同一供应商稳定。
   */
  templateInputOffset?: number;
  /**
   * 用户取消结算的 output 校准因子（token/字节）：outputTokens = round(bytesRelayed × tokensPerByte)。
   * SSE 线上字节含协议包装，直觉常数会错一个数量级，必须实测校准。
   */
  tokensPerByte?: number;
}

/** token 估算固定配置。 */
export interface TokenEstimateCalibration {
  /** 全局兜底权重。 */
  defaults: TextTokenWeights;
  /** 全局默认 tokensPerByte（字节→token，用户取消结算的 output 估算）。 */
  tokensPerByte: number;
  /** key = providerName。 */
  providers: Record<string, ProviderCalibration>;
  /** key = `providerName:model`（供应商+模型，主粒度）。 */
  models: Record<string, ProviderCalibration>;
}

/**
 * 固定校准配置（唯一配置来源，代码内常量）：
 * defaults 初始值来自 2026-08 实测；MiniMax-M3 的 tokensPerByte 来自
 * 2026-08-16 生产 trace 15 个样本（33.7 字节/token 中位）。
 */
export const DEFAULT_TOKEN_ESTIMATE_CALIBRATION: TokenEstimateCalibration = {
  defaults: { cjk: 0.7, word: 1.1, number: 1.0, symbol: 1.0 },
  tokensPerByte: 0.12,
  providers: {},
  models: {
    'minimax:MiniMax-M3': { tokensPerByte: 0.03 },
  },
};

/** 解析出的有效权重、偏移与字节校准因子。 */
export interface ResolvedCalibration {
  weights: TextTokenWeights;
  templateInputOffset: number;
  tokensPerByte: number;
}

/**
 * 解析固定配置：defaults ← providers[provider] ← models[`provider:model`]（后者优先）。
 * templateInputOffset / tokensPerByte 均取最高优先级命中的值；未命中保持默认。
 */
export function resolveCalibration(
  providerName?: string,
  model?: string,
  calibration: TokenEstimateCalibration = DEFAULT_TOKEN_ESTIMATE_CALIBRATION,
): ResolvedCalibration {
  let weights: TextTokenWeights = { ...calibration.defaults };
  let templateInputOffset = 0;
  let { tokensPerByte } = calibration;
  if (providerName) {
    const provider = calibration.providers[providerName];
    if (provider) {
      weights = { ...weights, ...provider.weights };
      templateInputOffset = provider.templateInputOffset ?? 0;
      tokensPerByte = provider.tokensPerByte ?? tokensPerByte;
    }
  }
  if (providerName && model) {
    const modelCalib = calibration.models[`${providerName}:${model}`];
    if (modelCalib) {
      weights = { ...weights, ...modelCalib.weights };
      templateInputOffset = modelCalib.templateInputOffset ?? templateInputOffset;
      tokensPerByte = modelCalib.tokensPerByte ?? tokensPerByte;
    }
  }
  return { weights, templateInputOffset, tokensPerByte };
}
