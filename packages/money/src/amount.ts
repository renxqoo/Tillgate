import { Decimal } from 'decimal.js';
import { PRICE_PER_MILLION, toDecimal } from './units.js';

/**
 * 计费公式（重构后：元 + decimal 全精度，账本永不 round）：
 *
 *   uncached = inputTokens - cachedInputTokens      （inputTokens 为总输入，含缓存命中）
 *   tokenBase = uncached×输入价 + cachedInputTokens×缓存价 + 输出×输出价（元·百万⁻¹ 量纲）
 *   unitBase = units × unitPrice                    （按次/按张/按秒/按字符，元·单位⁻¹）
 *   amount = (tokenBase / 1_000_000 + unitBase) × coefficient（元，Decimal 全精度）
 *
 * 计费单位单一真相：模型按 token 计价时 unitPrice=0（unitBase=0，行为不变）；
 * 按次/张/秒/字符计价时 token 三元组对该模型为 0。两类分量共用同一系数与资损防线。
 *
 * 全程 decimal.js 任意精度十进制运算，无浮点误差、无 round 损耗。
 * 即使单次请求产生 1e-6 元级的消耗（如 8 input + 1 output），也精确计费、入账，
 * 杜绝「真实 token 消耗却计费 0」的资损（重构前厘+Math.round 的根本缺陷）。
 *
 * 资损防线：所有输入先经 safe() 规范化（负数/NaN/Infinity → 0），cached 夹到 ≤ input，
 * 确保任何异常上游响应或配置错误都不会算出负金额（反向收费/白嫖）。
 */

export interface AmountInput {
  /** 输入总 tokens（含缓存命中） */
  inputTokens: number;
  /** 缓存命中输入 tokens（≤ inputTokens） */
  cachedInputTokens: number;
  outputTokens: number;
  /** 输入价（元/百万 token，decimal，如 0.002 = ¥0.002/百万） */
  inputPrice: Decimal | string | number;
  cacheInputPrice: Decimal | string | number;
  outputPrice: Decimal | string | number;
  /** 单位计量（按次=次数/按张=张数/按秒=秒数/按字符=字符数；token 模型传 0/缺省） */
  units?: number;
  /** 单位单价（元/单位；token 模型传 '0'/缺省） */
  unitPrice?: Decimal | string | number;
  /** 费率卡系数（小数，如 1.5） */
  coefficient: Decimal | string | number;
}

/** 规范化数值：非有限/负数 → 0（资损防御：绝不让异常输入算出负金额） */
function safe(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 计算费用（元，Decimal 全精度，不 round）。
 * @returns Decimal 金额（元）。调用方按需 toStorage() 存 DB。
 */
export function calcAmount(input: AmountInput): Decimal {
  const inputTokens = safe(input.inputTokens);
  const outputTokens = safe(input.outputTokens);
  const inputPrice = toDecimal(input.inputPrice);
  const cacheInputPrice = toDecimal(input.cacheInputPrice);
  const outputPrice = toDecimal(input.outputPrice);
  const coefficient = toDecimal(input.coefficient);
  // coefficient ≤ 0 → 视为 0（费率卡配置错误不允许免费/反向；安全兜底）
  const coeff = coefficient.lte(0) ? new Decimal(0) : coefficient;
  // cached 夹到 ≤ inputTokens（防异常上游返回 cached > total 导致负未缓存 + 超大缓存双计）
  const cachedInputTokens = Math.min(safe(input.cachedInputTokens), inputTokens);
  const uncached = inputTokens - cachedInputTokens;
  // tokenBase = uncached×输入价 + cached×缓存价 + 输出×输出价（元·百万⁻¹）
  const tokenBase = inputPrice
    .times(uncached)
    .plus(cacheInputPrice.times(cachedInputTokens))
    .plus(outputPrice.times(outputTokens));
  // unitBase = units × unitPrice（元；负单价钳 0——与 token 部分同资损规则）
  const unitPrice = toDecimal(input.unitPrice ?? 0);
  const unitBase = unitPrice.lt(0) ? new Decimal(0) : unitPrice.times(safe(input.units ?? 0));
  // amount = (tokenBase / 1e6 + unitBase) × coefficient（元，全精度，不 round）
  const amount = tokenBase.div(PRICE_PER_MILLION).plus(unitBase).times(coeff);
  // 永不返回负数（防御：即便异常输入组合也不反向收费）
  return amount.lt(0) ? new Decimal(0) : amount;
}
