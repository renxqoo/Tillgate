/**
 * 金额单位与换算（计算规范，见 data-model.md §1 与「计算规范」章节）
 *
 * 防错原则：
 *   1. 金额一律整数「厘」（1 元 = 1000 厘），禁止浮点金额入账
 *   2. 单价单位为「厘 / 百万 token」（整数）
 *   3. 系数（numeric(6,3)）计算时 ×1000 转毫整数
 *   4. 先乘后除，只在最后一步一次舍入（Math.round，半值进一）
 */

/** 厘/元 */
export const LI_PER_YUAN = 1000;
/** 单价分母：厘/百万 token */
export const PRICE_PER_MILLION = 1_000_000;
/** 系数放大：numeric(6,3) 三位小数 → 毫整数 */
export const COEFFICIENT_SCALE = 1000;

/** 展示用：厘 → 元字符串（两位小数，仅展示，不进账本） */
export function liToYuan(li: number): string {
  return (li / LI_PER_YUAN).toFixed(2);
}

/** 配置输入：元 → 厘（四舍五入到厘） */
export function yuanToLi(yuan: number): number {
  return Math.round(yuan * LI_PER_YUAN);
}

/** 系数（浮点，如 1.5）→ 毫整数（1500） */
export function coefficientToMilli(coeff: number): number {
  return Math.round(coeff * COEFFICIENT_SCALE);
}
