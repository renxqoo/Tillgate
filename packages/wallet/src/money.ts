/**
 * 金额规范（与 money 包同原则的独立实现——本包零 workspace 依赖，可整目录拎走）：
 *   1. 金额一律「元」，DB 存 numeric(38,18)；读写用 string，运算用 Decimal
 *   2. 账本永不 round：全精度参与余额与流水
 *   3. 禁科学计数法落库（PG numeric 不接受 1e-18）：toExpNeg 放宽到 -20
 *   4. precision 40：覆盖 38,18 全尺度加减不丢位
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 40, toExpNeg: -20, toExpPos: 40 });

export { Decimal };

/** DB 可存字符串（不 round、不科学计数法） */
export function toStorage(amount: Decimal): string {
  return amount.toString();
}

/** string → Decimal；非法（空/NaN/科学计数以外格式）抛 InvalidAmountError 由调用方包装 */
export function toDecimal(value: string): Decimal {
  return new Decimal(value);
}

/** 合法金额字符串：非负十进制、≤18 位小数、≤20 位整数（numeric(38,18) 落库前防御） */
const AMOUNT_PATTERN = /^\d{1,20}(\.\d{1,18})?$/;

export function isValidAmountString(value: string): boolean {
  return AMOUNT_PATTERN.test(value);
}

/** 金额字符串规范化（去前导零/尾零统一形态，幂等比对用） */
export function normalizeAmount(value: string): string {
  return new Decimal(value).toString();
}
