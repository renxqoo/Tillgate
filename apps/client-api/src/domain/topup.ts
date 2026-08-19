/**
 * 充值金额纯规则：面额闸 + 入账额推导。
 * 金额一律 string 进 string 出（domain Decimal 运算）；creditAmount 创建时定死，
 * 回调不重算——这是「渠道到账金额与入账金额解耦」的不变量源头。
 * 解析统一走 parsePositiveAmount：负数/NaN/科学计数法/超尺度结构性拒绝。
 */
import { parsePositiveAmount } from '@ai-gateway/domain';
import { AppError } from '../http/error-map.js';

/** 结构性金额输入校验（route 层快速 400；拒科学计数法/超尺度/负数/NaN） */
export function isValidAmountInput(raw: string): boolean {
  try {
    parsePositiveAmount(raw);
    return true;
  } catch {
    return false;
  }
}

/** 面额闸：min ≤ amount ≤ max（越界是策略拒绝；畸形金额走 domain 金额错误家谱）。
 *  同时拒绝 >2 位小数：渠道侧按分收款（cents 取整），三位小数会造出
 * 「下单 10.999 / 渠道收 11.00 / 金额核对永不匹配」的永久搁浅单。 */
export function assertTopupWithinLimit(amount: string, min: string, max: string): void {
  const value = parsePositiveAmount(amount);
  if (value.decimalPlaces() > 2) {
    throw new AppError(400, 'invalid_amount', '充值金额最多两位小数');
  }
  if (value.lessThan(min)) {
    throw new AppError(400, 'invalid_amount', `充值金额低于下限 ${min}`);
  }
  if (value.greaterThan(max)) {
    throw new AppError(400, 'invalid_amount', `充值金额高于上限 ${max}`);
  }
}

/** 入账额 = amount × rate（全精度不四舍五入——账本永不 round） */
export function computeCreditAmount(amount: string, rate: string): string {
  return parsePositiveAmount(amount).times(parsePositiveAmount(rate)).toString();
}

/** 回调金额核对：渠道实付与订单实付不等即拒（防「签名合法但金额篡改」） */
export function amountsMatch(callbackAmount: string, orderAmount: string): boolean {
  try {
    return parsePositiveAmount(callbackAmount).eq(parsePositiveAmount(orderAmount));
  } catch {
    return false;
  }
}
