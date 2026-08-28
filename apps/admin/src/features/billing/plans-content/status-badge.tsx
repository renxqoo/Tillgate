'use client';

import { StatusPill } from '@/components/status-pill';
import { useTranslations } from 'next-intl';

export function StatusBadge({ status }: { status: number }) {
  const t = useTranslations('plans');
  if (status === 0) {
    return <StatusPill tone="success" label={t('listed')} />;
  }
  return <StatusPill tone="neutral" label={t('unlisted')} />;
}
