/**
 * 营销首页 · 信任段落：为什么选择（Tabs）+ 计费（等价 SkillPay）+
 * 供应商（等价 企业专区）+ CTA + 页脚。
 */
import Link from 'next/link';
import { ArrowRight, ChevronRight } from 'lucide-react';

import { WhyTabs, type WhyTabData } from '@/features/public/why-tabs';
import { APP_CONFIG } from '@/config/app-config';
import { BlackPill, LogoMark, OutlinePill, SectionHeading, type LandingT } from './ui';

export const SUPPLIERS = [
  { nameKey: 'supDeepSeek', descKey: 'supDeepSeekDesc', grad: 'from-[#3957ff] to-[#0ea5e9]' },
  { nameKey: 'supZhipu', descKey: 'supZhipuDesc', grad: 'from-[#7c3aed] to-[#d946ef]' },
  { nameKey: 'supMiniMax', descKey: 'supMiniMaxDesc', grad: 'from-[#16a34a] to-[#7c3aed]' },
  { nameKey: 'supOpenRouter', descKey: 'supOpenRouterDesc', grad: 'from-[#f59e0b] to-[#ef4444]' },
  { nameKey: 'supOllama', descKey: 'supOllamaDesc', grad: 'from-[#64748b] to-[#0ea5e9]' },
] as const;

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

export function LandingFooter({ t }: { t: LandingT }) {
  const quick = [
    { href: '#models', label: t('navModels') },
    { href: '#guide', label: t('navGuide') },
    { href: '/pricing', label: t('navPricing') },
    { href: '/dashboard', label: t('enterConsole') },
  ];
  const dev = [
    { href: '/register', label: t('footerRegister') },
    { href: '/login', label: t('login') },
    { href: '/dashboard/keys', label: t('footerKeys') },
    { href: '/pricing', label: t('viewAllModels') },
  ];
  return (
    <footer className="border-t border-slate-100 py-12">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 grid-cols-1 sm:grid-cols-[1.6fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2">
            <LogoMark className="size-6 text-[#3957ff]" />
            <span className="font-bold tracking-tight text-slate-900">TokenLens</span>
          </div>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-slate-500">
            {t('footerTagline')}
          </p>
        </div>
        <div>
          <p className="mb-4 text-sm font-semibold text-slate-900">{t('quickLinks')}</p>
          <ul className="space-y-3 text-sm text-slate-500">
            {quick.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="transition-colors hover:text-slate-900">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-4 text-sm font-semibold text-slate-900">{t('developers')}</p>
          <ul className="space-y-3 text-sm text-slate-500">
            {dev.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="transition-colors hover:text-slate-900">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mx-auto mt-12 flex max-w-6xl flex-col gap-4 border-t border-slate-100 px-6 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-slate-400">{APP_CONFIG.copyright}</p>
        <span className="text-xs text-slate-300">v{APP_CONFIG.version}</span>
      </div>
    </footer>
  );
}
