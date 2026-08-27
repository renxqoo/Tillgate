import { ArrowRight } from 'lucide-react';

import { BlackPill } from './black-pill';
import type { LandingT } from './landing-shared';

export function BillingSection({ t }: { t: LandingT }) {
  const rows = [
    { label: t('billingRow1'), value: `+ ${t('billingRowValue')}` },
    { label: t('billingRow2'), value: `+ ${t('billingRowValue')}` },
    { label: t('billingRow3'), value: `+ ${t('billingRowValue')}` },
  ];
  return (
    <section className="py-20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="relative overflow-hidden rounded-[32px] bg-[#eef1f8] px-8 py-12 lg:px-14 lg:py-16">
          <div
            className="pointer-events-none absolute -bottom-24 -right-24 size-80 rounded-full border-2 border-dashed border-[#c9d4ee]"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute -bottom-10 -right-10 size-56 rounded-full border-2 border-dashed border-[#c9d4ee]"
            aria-hidden
          />
          <div className="relative grid items-center gap-12 lg:grid-cols-[7fr_5fr]">
            <div className="relative">
              <span className="rounded-full bg-white px-3 py-1 text-xs text-slate-400">
                {t('billingSample')}
              </span>
              <div className="mt-4 flex flex-col gap-4 sm:flex-row">
                <div className="w-full max-w-[430px] rounded-2xl bg-white p-6 shadow-[0_24px_64px_rgba(15,23,42,0.12)]">
                  <p className="text-xs text-slate-400">{t('cardWalletBalance')}</p>
                  <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                    {t('cardWalletBalanceValue')}
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-400">{t('cardWalletRecharge')}</p>
                      <p className="mt-0.5 text-sm font-semibold text-slate-900">
                        {t('cardWalletRechargeValue')}
                      </p>
                    </div>
                    <div className="rounded-xl bg-slate-50 px-4 py-3">
                      <p className="text-xs text-slate-400">{t('cardWalletBills')}</p>
                      <p className="mt-0.5 text-sm font-semibold text-slate-900">
                        {t('cardWalletBillsValue')}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="w-full max-w-[430px] overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(15,23,42,0.12)]">
                  <p className="border-b border-slate-100 px-5 py-3 text-xs font-medium text-slate-500">
                    {t('billingSample')}
                  </p>
                  <ul className="divide-y divide-slate-50">
                    {rows.map((row) => (
                      <li
                        key={row.label}
                        className="flex items-center justify-between px-5 py-3 text-[13px]"
                      >
                        <span className="text-slate-600">{row.label}</span>
                        <span className="font-medium text-emerald-600">{row.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
            <div>
              <span className="inline-block rounded-full bg-[#3957ff]/10 px-3 py-1 text-xs font-medium text-[#3957ff]">
                {t('billingEyebrow')}
              </span>
              <h2 className="mt-4 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">
                {t('billingTitle')}
              </h2>
              <p className="mt-4 text-[15px] leading-relaxed text-slate-500">{t('billingSub')}</p>
              <div className="mt-8">
                <BlackPill href="/dashboard/billing">
                  {t('billingCta')}
                  <ArrowRight className="size-4" />
                </BlackPill>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
