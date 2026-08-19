/**
 * 金额值对象（领域定律，非旧代码依赖）：
 *   1. 金额一律「元」，DB 存 numeric(38,18)；读写用 string，运算用 Decimal
 *   2. 账本永不 round：全精度参与余额与流水
 *   3. 禁科学计数法落库（PG numeric 不接受 1e-18）
 *   4. precision 40 覆盖 38,18 全尺度加减不丢位；独立构造器防污染宿主全局配置
 */
import DecimalJs from 'decimal.js';

export const Decimal = DecimalJs.clone({ precision: 40, toExpNeg: -20, toExpPos: 40 });
export type Decimal = DecimalJs;

/** DB 可存字符串（不 round、不科学计数法） */
export function toStorage(amount: Decimal): string {
  return amount.toString();
}

/** 金额字符串规范化（去前导零/尾零统一形态——幂等比对与指纹的稳定输入） */
export function normalizeAmount(value: string): string {
  return new Decimal(value).toString();
}

/** 合法金额字符串：非负十进制、≤18 位小数、≤20 位整数（numeric(38,18) 落库前防御） */
const AMOUNT_PATTERN = /^\d{1,20}(\.\d{1,18})?$/;

export function isValidAmountString(value: string): boolean {
  return AMOUNT_PATTERN.test(value);
}

export class InvalidAmountError extends Error {
  constructor(
    public readonly raw: unknown,
    public readonly reason: 'malformed' | 'non_positive' | 'out_of_scale',
  ) {
    super(`invalid amount: ${String(raw)} (${reason})`);
    this.name = 'InvalidAmountError';
  }
}

/**
 * 解析正金额（全部资金动词的入账/出账量）：有限十进制、> 0、且规范化后可落库。
 * 负数/NaN/Infinity/科学计数法/超尺度在这里结构性拒绝——任何异常输入都算不出错误金额。
 */
export function parsePositiveAmount(raw: string | number | Decimal): Decimal {
  const value = raw instanceof Decimal ? raw : new Decimal(raw as string);
  if (!value.isFinite()) throw new InvalidAmountError(raw, 'malformed');
  if (!value.gt(0)) throw new InvalidAmountError(raw, 'non_positive');
  const stored = toStorage(value);
  if (!isValidAmountString(stored)) throw new InvalidAmountError(raw, 'out_of_scale');
  return value;
}

/** 解析非负金额（授信地板等允许 0 的场景） */
export function parseNonNegativeAmount(raw: string | number | Decimal): Decimal {
  const value = raw instanceof Decimal ? raw : new Decimal(raw as string);
  if (!value.isFinite()) throw new InvalidAmountError(raw, 'malformed');
  if (value.lt(0)) throw new InvalidAmountError(raw, 'non_positive');
  const stored = toStorage(value);
  if (!isValidAmountString(stored)) throw new InvalidAmountError(raw, 'out_of_scale');
  return value;
}
