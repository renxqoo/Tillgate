import type { useTranslations } from 'next-intl';

import { formatMoney } from '@/features/shared/format';

/** 周期天数展示：30→月付，365→年付，其余按天（订阅页共用单点） */
export function planPeriodLabel(days: number, t: ReturnType<typeof useTranslations>): string {
  if (days === 30) return t('monthly');
  if (days === 365) return t('yearly');
  return t('periodDays', { days });
}

/** 元展示去尾零：¥100.00 → ¥100（整额/价格类展示） */
export function fmtYuan(value: string, locale: string): string {
  return formatMoney(value, locale).replace(/\.?0+$/, '');
}

/** 已用占比（0-100），仅用于进度条展示。 */
export function usagePercent(used: string, quota: string): number {
  const u = Number(used);
  const q = Number(quota);
  if (!Number.isFinite(u) || !Number.isFinite(q) || q <= 0) return 0;
  return Math.min(100, Math.max(0, (u / q) * 100));
}
