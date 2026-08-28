/**
 * 充值金额纯规则：面额闸 + 入账额推导。
 * 金额一律 string 进 string 出（Decimal 运算）；creditAmount 创建时定死，
 * 回调不重算——「渠道到账金额与入账金额解耦」的不变量源头。
 */
import { BillingErrors } from '../errors.js';
import { Decimal, parsePositiveAmount } from '../money.js';

/** 结构性金额输入校验（拒科学计数法/超尺度/负数/NaN） */
export function isValidAmountInput(raw: string): boolean {
  try {
    parsePositiveAmount(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * 面额闸：min ≤ amount ≤ max（越界是策略拒绝）。
 * 同时拒绝 >2 位小数：渠道侧按分收款（cents 取整），三位小数会造出
 * 「下单 10.999 / 渠道收 11.00 / 金额核对永不匹配」的永久搁浅单。
 */
export function assertTopupWithinLimit(amount: string, min: string, max: string): void {
  const value = parsePositiveAmount(amount);
  const reject = (reason: string) =>
    BillingErrors.business('topup_amount_invalid', { reason, amount, min, max });
  if (value.decimalPlaces() > 2) throw reject('too_many_decimals');
  if (value.lessThan(min)) throw reject('below_min');
  if (value.greaterThan(max)) throw reject('above_max');
}

/**
 * 入账额 = floor(amount × rate, 18 位小数)。乘积最多 20 位小数（2dp 面额 × 18dp
 * 费率），落库列 numeric(38,18) 表示不了第 19-20 位——按落库尺度先行收敛，响应值
 * 与存储/入账值同源（全精度直出会让响应 ≠ 账面 1e-18 级漂移）。floor 方向与佣金
 * 路径一致（派生入账额宁可少不多；差额低于落库尺度不可表示）。
 */
export function computeCreditAmount(amount: string, rate: string): string {
  const floored = parsePositiveAmount(amount)
    .times(parsePositiveAmount(rate))
    .toDecimalPlaces(18, Decimal.ROUND_FLOOR);
  // 乘积 < 1e-18 时 floor 到 0——落库后回调入账会撞 non_positive 永久 retryable
  // （已付款订单卡死）；下单即拒（渠道会话未建，无资金面影响）
  if (floored.isZero()) {
    throw BillingErrors.business('topup_amount_invalid', {
      reason: 'credit_below_representable',
      amount,
    });
  }
  return floored.toString();
}

/** 回调金额核对：渠道实付与订单实付不等即拒（防「签名合法但金额篡改」） */
export function amountsMatch(callbackAmount: string, orderAmount: string): boolean {
  try {
    return parsePositiveAmount(callbackAmount).eq(parsePositiveAmount(orderAmount));
  } catch {
    return false;
  }
}
