'use client';

import { useTranslations } from 'next-intl';

import { StatusPill } from '@tillgate/ui';

export function StatusBadge({ status }: { status: number }) {
  const t = useTranslations('keys');
  if (status === 0) {
    return <StatusPill tone="success">{t('statusActive')}</StatusPill>;
  }
  return <StatusPill tone="destructive">{t('statusRevoked')}</StatusPill>;
}
