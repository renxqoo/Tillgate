import { ArrowRight } from 'lucide-react';

import { BlackPill } from './black-pill';
import { LogoMark } from './logo-mark';
import { OutlinePill } from './outline-pill';
import type { LandingT } from './landing-shared';

export function CtaSection({ t, startHref }: { t: LandingT; startHref: string }) {
  return (
    <section className="pb-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="relative overflow-hidden rounded-[32px] bg-[#f5f5f7] px-8 py-16 text-center">
          <LogoMark className="absolute left-8 top-8 size-10 rotate-12 text-slate-300" />
          <LogoMark className="absolute bottom-8 right-10 size-12 -rotate-12 text-slate-300" />
          <h2 className="text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">
            {t('ctaTitle')}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-slate-500">
            {t('ctaDesc')}
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <BlackPill href={startHref}>
              {t('ctaFree')}
              <ArrowRight className="size-4" />
            </BlackPill>
            <OutlinePill href="/dashboard/api-guide">{t('ctaGuide')}</OutlinePill>
          </div>
        </div>
      </div>
    </section>
  );
}
