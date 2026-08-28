'use client';

import { useTranslations } from 'next-intl';

export function CallbackFallback() {
  const t = useTranslations('auth');
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      {t('completing')}
    </div>
  );
}
