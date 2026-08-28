import { WhyTabs, type WhyTabData } from '@/features/public/why-tabs';

import { SectionHeading } from './section-heading';
import type { LandingT } from './landing-shared';

export function WhySection({
  t,
  stats,
  tabA,
  tabB,
}: {
  t: LandingT;
  stats: Array<{ value: string; label: string }>;
  tabA: WhyTabData;
  tabB: WhyTabData;
}) {
  return (
    <section id="why" className="scroll-mt-20 bg-[#f8f9fc] py-20">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading eyebrow={t('navWhy')} title={t('whyTitle')} sub={t('whySub')} />
        <WhyTabs
          tabA={tabA}
          tabB={tabB}
          tabALabel={t('whyTabPersonal')}
          tabBLabel={t('whyTabOrg')}
        />
        <div className="mt-16 grid grid-cols-2 gap-10 border-t border-slate-200/70 pt-12 text-center md:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label}>
              <p className="text-4xl font-bold tracking-tight text-slate-900 md:text-5xl">
                {s.value}
              </p>
              <p className="mt-2 text-sm text-slate-400">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
