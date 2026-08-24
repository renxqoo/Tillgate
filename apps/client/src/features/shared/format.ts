/**
 * 展示格式化（app 装配层）：金额/日期/数字。
 *
 * 与 v1 的口径差异（DESIGN D-D，MIGRATION §4 在案）：
 *   - 金额：v1 字符串级 4 位**截断** → Intl 货币格式 2–4 位**四舍五入**（信息量保留）；
 *   - 日期：v1 容器本地时区 → 显式 DISPLAY_TZ（B8 修复；SSR 与浏览器同值无水合漂移）。
 * formatter 构造有成本，按 locale/currency 维度缓存。
 */
import { createDateFormatter } from '@tillgate/ui';

import { DEFAULT_CURRENCY, DISPLAY_TZ } from '@/config/display';

export type DisplayLocale = string;

const dateTimeCache = new Map<string, ReturnType<typeof createDateFormatter>>();

function dateFormatters(locale: DisplayLocale) {
  let fmt = dateTimeCache.get(locale);
  if (!fmt) {
    fmt = createDateFormatter({ locale, timeZone: DISPLAY_TZ });
    dateTimeCache.set(locale, fmt);
  }
  return fmt;
}

/** ISO/Date → DISPLAY_TZ `medium` 日期时间；空值 —、无效原样返回 */
export function formatDateTime(input: string | null | undefined, locale: DisplayLocale): string {
  if (!input) return '—';
  try {
    return dateFormatters(locale).formatDateTime(input);
  } catch {
    return input;
  }
}

/** ISO/Date → DISPLAY_TZ 仅日期 */
export function formatDate(input: string | null | undefined, locale: DisplayLocale): string {
  if (!input) return '—';
  try {
    return dateFormatters(locale).formatDate(input);
  } catch {
    return input;
  }
}

const moneyCache = new Map<string, Intl.NumberFormat>();

/** 金额（元，字符串/数字）→ Intl 货币格式（2–4 位自适应四舍五入；无效返回 "0"） */
export function formatMoney(
  amount: string | number | null | undefined,
  locale: DisplayLocale,
  currency: string = DEFAULT_CURRENCY,
): string {
  if (amount === null || amount === undefined || amount === '') return '0';
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return '0';
  const key = `${locale}:${currency}`;
  let fmt = moneyCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
    moneyCache.set(key, fmt);
  }
  // -0 不输出负号（v1 口径保持）
  return fmt.format(value === 0 ? 0 : value);
}

/** 整数计数（四舍五入，无分组——v1 语义保持） */
export function formatInt(v: string | number | null | undefined): string {
  const n = Number(v);
  return Math.round(Number.isFinite(n) ? n : 0).toString();
}

/** 毫秒 → 友好展示：<1s 显示 ms，>=1s 显示秒（保留 2 位） */
export function msToHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 计价单位词（zh/en 双语表；未知单位回落通用词） */
export function unitWord(pricingUnit: string | null | undefined, locale: DisplayLocale): string {
  const zh: Record<string, string> = {
    image: '张',
    second: '秒',
    char: '字符',
    request: '次',
  };
  const en: Record<string, string> = {
    image: 'image',
    second: 'sec',
    char: 'char',
    request: 'request',
  };
  const table = locale === 'zh' ? zh : en;
  if (!pricingUnit) return locale === 'zh' ? '单位' : 'unit';
  return table[pricingUnit] ?? (locale === 'zh' ? '单位' : 'unit');
}
