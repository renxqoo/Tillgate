import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { SectionHeading } from './section-heading';
import type { LandingT } from './landing-shared';

export const SUPPLIERS = [
  { nameKey: 'supDeepSeek', descKey: 'supDeepSeekDesc', grad: 'from-[#3957ff] to-[#0ea5e9]' },
  { nameKey: 'supZhipu', descKey: 'supZhipuDesc', grad: 'from-[#7c3aed] to-[#d946ef]' },
  { nameKey: 'supMiniMax', descKey: 'supMiniMaxDesc', grad: 'from-[#16a34a] to-[#7c3aed]' },
  { nameKey: 'supOpenRouter', descKey: 'supOpenRouterDesc', grad: 'from-[#f59e0b] to-[#ef4444]' },
  { nameKey: 'supOllama', descKey: 'supOllamaDesc', grad: 'from-[#64748b] to-[#0ea5e9]' },
] as const;

export function SuppliersSection({ t }: { t: LandingT }) {
  return (
    <section className="pb-20">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading eyebrow={t('billingEyebrow')} title={t('supTitle')} sub={t('supSub')} />
        <div className="grid gap-6 md:grid-cols-3">
          {SUPPLIERS.slice(0, 3).map((s) => (
            <div
              key={s.nameKey}
              className="group rounded-2xl border border-slate-100 bg-white p-6 transition-all hover:-translate-y-0.5 hover:shadow-lg"
            >
              <div className="flex items-center gap-3">
                <span
                  className={`flex size-11 items-center justify-center rounded-xl bg-gradient-to-br ${s.grad} text-base font-bold text-white`}
                >
                  {t(s.nameKey).slice(0, 1)}
                </span>
                <p className="font-semibold text-slate-900">{t(s.nameKey)}</p>
                <span className="ml-auto rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-600">
                  {t('supChip')}
                </span>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-slate-500">{t(s.descKey)}</p>
              <Link
                href="/pricing"
                className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-slate-700 transition-colors group-hover:text-slate-900"
              >
                {t('supViewAll')}
                <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
