/**
 * 金额值对象（DESIGN §2.2 全包唯一金额契约；迁移自旧仓 domain/wallet/money.ts 超集语义）：
 *   1. 金额一律「元」，DB 存 numeric(38,18)；读写用 string，运算用 Decimal
 *   2. 账本永不 round：全精度参与余额与流水
 *   3. 禁科学计数法落库（PG numeric 不接受 1e-18）
 *   4. precision 40 覆盖 38,18 全尺度加减不丢位；独立构造器防污染宿主全局配置
 * 垃圾串构造异常在此归类为 invalid_amount（B3 同型修复：Decimal 构造异常不得逃逸出分类）。
 */
import DecimalJs from 'decimal.js';
import { BillingErrors } from './errors.js';

export const Decimal = DecimalJs.clone({ precision: 40, toExpNeg: -20, toExpPos: 40 });
export type Decimal = DecimalJs;

/** DB 可存字符串（不 round、不科学计数法） */
export function toStorage(amount: Decimal): string {
  return amount.toString();
}

/**
 * 金额字符串规范化（去前导零/尾零统一形态——幂等比对与指纹的稳定输入）。
 * 防线对称（B3 同族）：垃圾串的 Decimal 构造异常在此归类为 invalid_amount，
 * 不允许未分类异常逃逸（与 parsePositiveAmount 的 toDecimal 守卫同一口径）。
 */
export function normalizeAmount(value: string): string {
  try {
    return new Decimal(value).toString();
  } catch {
    throw BillingErrors.business('invalid_amount', { raw: String(value), reason: 'malformed' });
  }
}

/** 合法金额字符串：非负十进制、≤18 位小数、≤20 位整数（numeric(38,18) 落库前防御） */
const AMOUNT_PATTERN = /^\d{1,20}(\.\d{1,18})?$/;

export function isValidAmountString(value: string): boolean {
  return AMOUNT_PATTERN.test(value);
}

function invalidAmount(raw: unknown, reason: 'malformed' | 'non_positive' | 'out_of_scale'): never {
  throw BillingErrors.business('invalid_amount', { raw: String(raw), reason });
}

function toDecimal(raw: string | number | Decimal): Decimal {
  if (raw instanceof Decimal) return raw;
  try {
    return new Decimal(raw);
  } catch {
    return invalidAmount(raw, 'malformed');
  }
}

/**
 * 解析正金额（全部资金动词的入账/出账量）：有限十进制、> 0、且规范化后可落库。
 * 负数/NaN/Infinity/科学计数法/超尺度在这里结构性拒绝——任何异常输入都算不出错误金额。
 */
export function parsePositiveAmount(raw: string | number | Decimal): Decimal {
  const value = toDecimal(raw);
  if (!value.isFinite()) return invalidAmount(raw, 'malformed');
  if (!value.gt(0)) return invalidAmount(raw, 'non_positive');
  if (!isValidAmountString(toStorage(value))) return invalidAmount(raw, 'out_of_scale');
  return value;
}

/** 解析非负金额（授信地板等允许 0 的场景） */
export function parseNonNegativeAmount(raw: string | number | Decimal): Decimal {
  const value = toDecimal(raw);
  if (!value.isFinite()) return invalidAmount(raw, 'malformed');
  if (value.lt(0)) return invalidAmount(raw, 'non_positive');
  if (!isValidAmountString(toStorage(value))) return invalidAmount(raw, 'out_of_scale');
  return value;
}
