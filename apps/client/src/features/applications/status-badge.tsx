'use client';

import { useTranslations } from 'next-intl';

import { StatusPill } from '@tillgate/ui';

export function StatusBadge({ status }: { status: number }) {
  const t = useTranslations('apps');
  return status === 0 ? (
    <StatusPill tone="success">{t('statusEnabled')}</StatusPill>
  ) : (
    <StatusPill tone="neutral">{t('statusDisabled')}</StatusPill>
  );
}
