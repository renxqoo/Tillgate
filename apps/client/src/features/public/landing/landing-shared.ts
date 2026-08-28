import type { getTranslations } from 'next-intl/server';

export type LandingT = Awaited<ReturnType<typeof getTranslations<'landing'>>>;
export type PricingT = Awaited<ReturnType<typeof getTranslations<'pricing'>>>;

/** 数字价展示：元/百万 Token 口径 */
export function fmtPrice(price: string): string {
  const n = Number(price);
  if (!Number.isFinite(n) || n === 0) return '—';
  return `¥${String(Number(n.toFixed(4)))}`;
}

/** 计价方式目录键（pricing 命名空间）；未知 unit 原样回显 */
const PRICING_UNIT_KEYS: Record<string, string> = {
  token: 'unitToken',
  request: 'unitRequest',
  image: 'unitImage',
  second: 'unitSecond',
  char: 'unitChar',
};

export function formatUnit(tPricing: PricingT, unit: string): string {
  const unitKey = PRICING_UNIT_KEYS[unit];
  return unitKey ? tPricing(unitKey) : unit;
}
