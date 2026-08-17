import { Decimal } from 'decimal.js';
import { PRICE_PER_MILLION, toDecimal } from './units.js';

function safe(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export interface ReservationEstimateInput {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  inputPrice: Decimal | string | number;
  /** 授权时无法预知缓存命中量，必须按两种输入单价中较高者覆盖。 */
  cacheInputPrice?: Decimal | string | number;
  outputPrice: Decimal | string | number;
  /** 单位计量上界（如 images 的 n 张、audio 的秒数上界；token 模型传 0/缺省） */
  unitUpperBound?: number;
  /** 单位单价（元/单位；token 模型传 '0'/缺省） */
  unitPrice?: Decimal | string | number;
  coefficient: Decimal | string | number;
}

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

/**
 * 预扣估算拒绝（类型化跨包契约：消费方 instanceof 判定，
 * 不做 message 字符串匹配——文案变更不得破坏上游分类）。
 */
export class ReservationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_reservation_estimate'
      | 'invalid_reservation_limit'
      | 'reservation_limit_exceeded',
  ) {
    super(code);
    this.name = 'ReservationError';
  }
}

/** 余额由账本事务足额判断；风险上限只用于拒绝，绝不截断。 */
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
