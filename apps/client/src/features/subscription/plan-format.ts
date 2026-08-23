import type { useTranslations } from 'next-intl';

/** 周期天数展示：30→月付，365→年付，其余按天（订阅页共用单点） */
export function planPeriodLabel(
  days: number,
  t: ReturnType<typeof useTranslations>,
): string {
  if (days === 30) return t('monthly');
  if (days === 365) return t('yearly');
  return t('periodDays', { days });
}
