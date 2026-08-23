import { Button } from '@tokenlens/ui';
import Link from 'next/link';

import { ArrowRight, ShieldCheck } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { APP_CONFIG } from '@/config/app-config';

export default async function Landing() {
  const t = await getTranslations('auth');
  return (
    <main className="@container/main mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-8 px-4 py-16">
      <div className="space-y-2 text-center">
        <div className="flex items-center justify-center gap-2">
          <ShieldCheck className="size-7 text-primary" />
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
            {t('landingTitle', { name: APP_CONFIG.name })}
          </h1>
        </div>
        <p className="text-muted-foreground">{t('inviteOnly')}</p>
      </div>

      <Button
        size="lg"
        render={
          <Link href="/login">
            {t('goToLogin')} <ArrowRight />
          </Link>
        }
      />
    </main>
  );
}
