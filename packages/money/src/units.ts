/**
 * 金额单位与计算规范（重构后：元 + numeric 全精度）。
 *
 * 设计原则（金融级，与 data-model.md 一致）：
 *   1. 金额一律「元」，DB 存 numeric(24,18)（精确到 1e-18 元，累加不丢精度）
 *   2. 单价为「元 / 百万 token」（decimal，可带小数）
 *   3. 系数为小数（如 1.5），不再 ×1000 编码成毫整数
 *   4. 账本永不 round：calcAmount 返回 Decimal，全精度参与余额扣减/流水
 *   5. 仅「对外结算」边界（平台↔渠道/提现）用银行家舍入到分（round-half-even），
 *      尾差入平台专门科目；账本内部零 round
 *
 * 计算库：decimal.js（任意精度十进制，避免 IEEE754 浮点误差）。
 * 边界约定：DB 读写用 string（drizzle numeric 原生 string），业务运算用 Decimal。
 */
import Decimal from 'decimal.js';

/** 单价分母：元/百万 token */
export const PRICE_PER_MILLION = 1_000_000;

/** 银行家舍入（round-half-even）：仅对外结算到分时使用 */
Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN });
export { Decimal };

/**
 * 把 Decimal 金额舍入到「分」（0.01 元），用银行家舍入（half-even）。
 * 仅用于对外结算边界（平台付渠道 / 用户提现），账本内部不调用。
 * @returns 两位小数的元值（Decimal）
 */
export function toCents(amount: Decimal): Decimal {
  return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

/**
 * 把 Decimal 格式化为 DB 可存的 string（numeric 列接受任意精度字符串）。
 * 不做任何 round——保留全精度，让 DB numeric 存真实值。
 */
export function toStorage(amount: Decimal): string {
  return amount.toString();
}

/**
 * 把 string/number/Decimal 统一转成 Decimal（DB 读出的 numeric 是 string）。
 * 非法输入（空/NaN）→ 0（防御，防污染运算）。
 */
export function toDecimal(v: Decimal | string | number | null | undefined): Decimal {
  if (v instanceof Decimal) return v;
  if (v === null || v === undefined || v === '') return new Decimal(0);
  const d = new Decimal(v);
  return d.isFinite() ? d : new Decimal(0);
}
