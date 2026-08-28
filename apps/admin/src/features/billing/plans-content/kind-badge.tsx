'use client';

import { StatusPill } from '@/components/status-pill';
import { useTranslations } from 'next-intl';

import type { PlanRow } from '@tillgate/api-client';

export function KindBadge({ kind }: { kind: PlanRow['kind'] }) {
  const t = useTranslations('plans');
  if (kind === 'pack') {
    return <StatusPill tone="accent" label={t('pack')} />;
  }
  return <StatusPill tone="info" label={t('subscription')} />;
}
