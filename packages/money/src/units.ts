/**
 * 金额单位与计算规范（元 + numeric 全精度）。
 *
 * 设计原则（金融级，与 data-model.md 一致）：
 *   1. 金额一律「元」，DB 存 numeric(38,18)（精确到 1e-18 元，累加不丢精度）
 *   2. 单价为「元 / 百万 token」（decimal，可带小数）
 *   3. 系数为小数（如 1.5），不做整数编码
 *   4. 账本永不 round：calcAmount 返回 Decimal，全精度参与余额扣减/流水
 *
 * 计算库：decimal.js（任意精度十进制，避免 IEEE754 浮点误差）。
 * 边界约定：DB 读写用 string（drizzle numeric 原生 string），业务运算用 Decimal。
 */
import Decimal from 'decimal.js';

/** 单价分母：元/百万 token */
export const PRICE_PER_MILLION = 1_000_000;

export { Decimal };

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
