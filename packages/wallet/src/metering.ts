/**
 * 计费公式与预扣估算——wallet 管钱的计费策略面。
 * 经 `@ai-gateway/wallet/metering` 子导出消费;不进根导出,保住内核「业务无关、
 * 整目录拎出独立仓」的契约。Decimal 用本包 money.ts 的独立 clone
 * (precision 40、禁科学计数法)。
 *
 * 计算规范(与 data-model.md 一致):
 *   1. 金额一律「元」,DB 存 numeric(38,18);读写用 string,运算用 Decimal
 *   2. 账本永不 round:calcAmount 返回 Decimal,全精度参与余额扣减/流水
 *   3. 单价为「元 / 百万 token」(decimal);按次/张/秒/字符计价走 units × unitPrice
 */
import { Decimal, toStorage } from './money';
import { ReservationError, type ReservationErrorCode } from './errors';

export { Decimal, toStorage };
export { ReservationError, type ReservationErrorCode };

/** 单价分母:元/百万 token */
export const PRICE_PER_MILLION = 1_000_000;

/**
 * 把 string/number/Decimal 统一转成 Decimal(DB 读出的 numeric 是 string)。
 * 非法输入(空/NaN)→ 0(防御,防污染运算)。
 */
export function toDecimal(v: Decimal | string | number | null | undefined): Decimal {
  if (v instanceof Decimal) return v;
  if (v === null || v === undefined || v === '') return new Decimal(0);
  const d = new Decimal(v);
  return d.isFinite() ? d : new Decimal(0);
}

/** 规范化数值:非有限/负数 → 0(资损防御:绝不让异常输入算出负金额) */
function safe(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export interface AmountInput {
  /** 输入总 tokens(含缓存命中) */
  inputTokens: number;
  /** 缓存命中输入 tokens(≤ inputTokens) */
  cachedInputTokens: number;
  outputTokens: number;
  /** 输入价(元/百万 token,decimal,如 0.002 = ¥0.002/百万) */
  inputPrice: Decimal | string | number;
  cacheInputPrice: Decimal | string | number;
  outputPrice: Decimal | string | number;
  /** 单位计量(按次=次数/按张=张数/按秒=秒数/按字符=字符数;token 模型传 0/缺省) */
  units?: number;
  /** 单位单价(元/单位;token 模型传 '0'/缺省) */
  unitPrice?: Decimal | string | number;
  /** 费率卡系数(小数,如 1.5) */
  coefficient: Decimal | string | number;
}

/**
 * 计算费用(元,Decimal 全精度,不 round):
 *
 *   uncached  = inputTokens − cachedInputTokens(inputTokens 为总输入,含缓存命中)
 *   tokenBase = uncached×输入价 + cached×缓存价 + 输出×输出价(元·百万⁻¹ 量纲)
 *   unitBase  = units × unitPrice(按次/张/秒/字符,元·单位⁻¹)
 *   amount    = (tokenBase / 1e6 + unitBase) × coefficient(元,Decimal 全精度)
 *
 * 资损防线:输入先经 safe() 规范化(负/NaN/Infinity → 0),cached 夹到 ≤ input,
 * coefficient ≤ 0 与负单价钳 0——任何异常上游响应或配置错误都算不出负金额
 * (反向收费/白嫖),也杜绝「真实 token 消耗却计费 0」的厘级资损。
 * @returns Decimal 金额(元)。调用方按需 toStorage() 存 DB。
 */
export function calcAmount(input: AmountInput): Decimal {
  const inputTokens = safe(input.inputTokens);
  const outputTokens = safe(input.outputTokens);
  const inputPrice = toDecimal(input.inputPrice);
  const cacheInputPrice = toDecimal(input.cacheInputPrice);
  const outputPrice = toDecimal(input.outputPrice);
  const coefficient = toDecimal(input.coefficient);
  // coefficient ≤ 0 → 视为 0(费率卡配置错误不允许免费/反向;安全兜底)
  const coeff = coefficient.lte(0) ? new Decimal(0) : coefficient;
  // cached 夹到 ≤ inputTokens(防异常上游返回 cached > total 导致负未缓存 + 超大缓存双计)
  const cachedInputTokens = Math.min(safe(input.cachedInputTokens), inputTokens);
  const uncached = inputTokens - cachedInputTokens;
  const tokenBase = inputPrice
    .times(uncached)
    .plus(cacheInputPrice.times(cachedInputTokens))
    .plus(outputPrice.times(outputTokens));
  const unitPrice = toDecimal(input.unitPrice ?? 0);
  const unitBase = unitPrice.lt(0) ? new Decimal(0) : unitPrice.times(safe(input.units ?? 0));
  const amount = tokenBase.div(PRICE_PER_MILLION).plus(unitBase).times(coeff);
  return amount.lt(0) ? new Decimal(0) : amount;
}

export interface ReservationEstimateInput {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  inputPrice: Decimal | string | number;
  /** 授权时无法预知缓存命中量,必须按两种输入单价中较高者覆盖。 */
  cacheInputPrice?: Decimal | string | number;
  outputPrice: Decimal | string | number;
  /** 单位计量上界(如 images 的 n 张、audio 的秒数上界;token 模型传 0/缺省) */
  unitUpperBound?: number;
  /** 单位单价(元/单位;token 模型传 '0'/缺省) */
  unitPrice?: Decimal | string | number;
  coefficient: Decimal | string | number;
}

/** 预扣上界估算:输入按两种输入价较高者、输出按上界、单位按上界——宁可多押不可少押。 */
export function estimateMaxCost(input: ReservationEstimateInput): Decimal {
  const coefficient = toDecimal(input.coefficient);
  if (!coefficient.isFinite() || coefficient.lte(0)) return new Decimal(0);
  const inputPrice = toDecimal(input.inputPrice);
  const cacheInputPrice = toDecimal(input.cacheInputPrice ?? input.inputPrice);
  const conservativeInputPrice = Decimal.max(inputPrice, cacheInputPrice);
  const tokenBase = conservativeInputPrice
    .times(safe(input.estimatedInputTokens))
    .plus(toDecimal(input.outputPrice).times(safe(input.maxOutputTokens)));
  const unitPrice = toDecimal(input.unitPrice ?? 0);
  const unitBase = unitPrice.lt(0) ? new Decimal(0) : unitPrice.times(safe(input.unitUpperBound ?? 0));
  const cost = tokenBase.div(PRICE_PER_MILLION).plus(unitBase).times(coefficient);
  return cost.isFinite() && cost.gte(0) ? cost : new Decimal(0);
}

/** 余额由账本事务足额判断;风险上限只用于拒绝,绝不截断。 */
export function requiredReservation(
  estimate: Decimal | string | number,
  reservationLimit: Decimal | string | number,
): Decimal {
  const required = toDecimal(estimate);
  const limit = toDecimal(reservationLimit);
  if (!required.isFinite() || required.lt(0))
    throw new ReservationError('invalid_reservation_estimate');
  if (!limit.isFinite() || limit.lte(0))
    throw new ReservationError('invalid_reservation_limit');
  if (required.gt(limit)) throw new ReservationError('reservation_limit_exceeded');
  return required;
}
