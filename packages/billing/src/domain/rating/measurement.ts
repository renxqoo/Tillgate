/**
 * 计量描述符注册表（层 1）——「这个模型按什么计量」的单一真相。
 *
 * 每个定价单位（pricingUnit）一个描述符，回答两个问题：
 *   unitsUpperBoundOf —— 预扣上界（保守估计，宁可多押）——报价构建消费（buildQuote）
 *   unitsOf            —— 结算实值（响应实值优先，参数兜底）——收据装配消费（receipt）
 *
 * 新单位类型（如按字节、按像素）= 在注册表加一个描述符，零侵入公式与管线。
 * token 族的输入估算在 inference/ai（estimateInputTokens 单一真相）——本层不重复实现；
 * token 模型不走单位轴（units 恒 0），金额全部走 token 三价。
 */

export interface MeasurementDescriptor {
  /** 预扣上界（保守估计） */
  unitsUpperBoundOf(body: Record<string, unknown>): number;
  /** 结算实值（sync 模态从响应体取；任务族从快照取） */
  unitsOf(body: Record<string, unknown>, response?: unknown): number;
}

/** n 倍数参数取正整数，缺省 1（张/次类上界；与路由层 n≤16 校验同口径） */
function positiveN(body: Record<string, unknown>): number {
  const n = body.n;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? Math.min(n, 16) : 1;
}

/**
 * duration 钳制（4-15s，缺省 6——video 按秒计费的时长上界/快照，
 * new-api #5498 教训：上游缺省时长与请求意图不符导致少押）。
 */
function clampedDuration(body: Record<string, unknown>): number {
  const d = body.duration;
  if (typeof d === 'number' && Number.isFinite(d)) return Math.min(15, Math.max(4, Math.round(d)));
  return 6;
}

/** 音频秒（multipart 字节推的 audioSeconds，向上取整；解析失败由路由层兜底 1s） */
function audioSeconds(body: Record<string, unknown>): number | null {
  const s = body.audioSeconds;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? Math.ceil(s) : null;
}

/**
 * 按秒计量实值：音频秒（STT 文件字节推得，确定性——即结算值）优先于
 * video duration（请求声明，钳制）。同一实现供预扣与结算——上界即快照。
 */
function secondsOf(body: Record<string, unknown>): number {
  return audioSeconds(body) ?? clampedDuration(body);
}

/** images 族结算实值：响应张数（data.length），兜底请求 n，最少 1 */
function imageUnits(body: Record<string, unknown>, response?: unknown): number {
  const data = (response as { data?: unknown } | undefined)?.data;
  const fromResponse = Array.isArray(data) ? data.length : 0;
  return Math.max(1, fromResponse > 0 ? fromResponse : positiveN(body));
}

/** 语音合成字符数（码点口径——emoji/增补平面不被 UTF-16 拆半） */
function charCount(body: Record<string, unknown>): number {
  const input = body.input;
  return typeof input === 'string' ? [...input].length : 0;
}

export const MEASUREMENTS: Record<string, MeasurementDescriptor> = {
  token: {
    // token 模型不走单位轴：输入上界由管线 estimateInputTokens 单独供 token 价公式
    unitsUpperBoundOf: () => 0,
    unitsOf: () => 0,
  },
  image: {
    unitsUpperBoundOf: positiveN,
    unitsOf: imageUnits,
  },
  second: {
    unitsUpperBoundOf: secondsOf,
    unitsOf: secondsOf,
  },
  char: {
    unitsUpperBoundOf: charCount,
    unitsOf: charCount,
  },
  request: {
    unitsUpperBoundOf: () => 1,
    unitsOf: () => 1,
  },
};

/** 按定价单位取描述符；未知单位按次兜底 */
export function measurementOf(pricingUnit: string): MeasurementDescriptor {
  return MEASUREMENTS[pricingUnit] ?? MEASUREMENTS.request!;
}
