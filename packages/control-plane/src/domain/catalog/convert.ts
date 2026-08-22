/**
 * 目录比价换算（纯函数）：目录参考价 → CNY 预填（唯一换算点，预填与比价共用）。
 */
import Decimal from 'decimal.js';
import type { CatalogCurrency } from './catalog';

/** 目录展示保留 12 位有效数字；运算始终走 Decimal。 */
function cleanPrice(n: string | number | Decimal): string {
  return new Decimal(n).toSignificantDigits(12).toString();
}

/** 目录参考输入价换算到 CNY（预填与比价共用的唯一换算点；CNY 源原样返回；无汇率返回 null） */
export function toCny(
  price: string,
  currency: CatalogCurrency,
  effectiveRate: string | null,
): string | null {
  if (currency === 'CNY') return price;
  if (effectiveRate == null) return null;
  return cleanPrice(new Decimal(price).times(effectiveRate));
}
