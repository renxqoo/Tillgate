/**
 * 营销首页 · 免费模型榜单（等价 SkillHunt）+ 接入指南（等价 Plugin 广场）。
 * 榜单数据来自 /v1/pricing?free=true；示例代码使用真实部署 Base URL。
 */
import Link from 'next/link';
import { ChevronRight, Terminal } from 'lucide-react';

import { CopyPill } from '@/features/public/copy-pill';
import type { PricingModel } from '@tokenlens/api-client';

import { SectionHeading, fmtPrice, formatUnit, type LandingT, type PricingT } from './ui';
import { buildSamples } from './samples';

function contextLabel(t: LandingT, n: number | null) {
  return n ? ` · ${t('boardContext', { n: Math.round(n / 1000) })}` : '';
}

export function ModelsBoard({
  t,
  tPricing,
  featured,
  ranks,
}: {
  t: LandingT;
  tPricing: PricingT;
  featured?: PricingModel;
  ranks: PricingModel[];
}) {
  return (
    <section id="models" className="scroll-mt-20 py-20">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading eyebrow={t('boardEyebrow')} title={t('boardTitle')} sub={t('boardSub')} />
        {!featured ? (
          <p className="text-center text-sm text-slate-400">
            {t.rich('pricingUnavailable', {
              link: (chunks) => (
                <Link className="underline underline-offset-2" href="/pricing">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        ) : (
          <div className="grid gap-8 lg:grid-cols-12">
            {/* 精选卡片 */}
            <div className="relative overflow-hidden rounded-3xl bg-[#f5f7fb] p-8 lg:col-span-5">
              <div
                className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-[#3957ff]/10 blur-3xl"
                aria-hidden
              />
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-600">
                <span className="text-[#3957ff]">✦</span>
                {t('boardFeaturedChip')}
              </span>
              <div className="relative mt-6">
                <span className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#3957ff] to-[#7c3aed] text-xl font-bold text-white">
                  {featured.externalName.slice(0, 1)}
                </span>
                <h3 className="mt-4 font-mono text-lg font-semibold tracking-tight text-slate-900">
                  {featured.externalName}
                </h3>
                <p className="mt-1 text-xs text-slate-400">
                  {formatUnit(tPricing, featured.pricingUnit)}
                  {contextLabel(t, featured.contextLength)}
                </p>
                <p className="mt-4 text-sm leading-relaxed text-slate-500">
                  {t('boardFeaturedText')}
                </p>
                <div className="mt-6 grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-white px-4 py-3">
                    <p className="text-xs text-slate-400">{t('boardInput')}</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">
                      {featured.isFree ? t('boardFree') : fmtPrice(featured.inputPrice)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-white px-4 py-3">
                    <p className="text-xs text-slate-400">{t('boardOutput')}</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">
                      {featured.isFree ? t('boardFree') : fmtPrice(featured.outputPrice)}
                    </p>
                  </div>
                </div>
                <div className="mt-6 flex items-center gap-3">
                  <Link
                    href="/pricing"
                    className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300"
                  >
                    {t('boardViewAll')}
                    <ChevronRight className="size-4" />
                  </Link>
                  <span className="text-xs text-slate-400">{t('boardFeaturedMeta')}</span>
                </div>
              </div>
            </div>

            {/* 榜单列表 */}
            <div className="rounded-3xl border border-slate-100 bg-white p-6 lg:col-span-7">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-2 px-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{t('boardRankTitle')}</p>
                  <p className="mt-0.5 text-xs text-slate-400">{t('boardRankSub')}</p>
                </div>
                <Link
                  href="/pricing"
                  className="text-xs font-medium text-[#3957ff] hover:underline"
                >
                  {t('boardViewAll')} →
                </Link>
              </div>
              <ul className="space-y-1">
                {ranks.map((m, i) => (
                  <li key={m.id}>
                    <Link
                      href="/pricing"
                      className="group flex items-center gap-4 rounded-2xl px-2 py-3 transition-colors hover:bg-slate-50"
                    >
                      <span className="w-7 shrink-0 text-2xl font-bold text-slate-300">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#3957ff] to-[#7c3aed] text-sm font-bold text-white">
                        {m.externalName.slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-sm font-medium text-slate-900">
                          {m.externalName}
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-400">
                          {formatUnit(tPricing, m.pricingUnit)}
                          {contextLabel(t, m.contextLength)}
                        </span>
                      </span>
                      <span className="hidden text-xs text-slate-400 sm:block">
                        {t('boardInput')} {m.isFree ? t('boardFree') : fmtPrice(m.inputPrice)} ·{' '}
                        {t('boardOutput')} {m.isFree ? t('boardFree') : fmtPrice(m.outputPrice)}
                      </span>
                      <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-600">
                        {t('boardFree')}
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export function GuideSection({ t, base }: { t: LandingT; base: string }) {
  const s = buildSamples(t, base);
  const samples = [
    { lang: t('guidePython'), badge: 'openai · v1', code: s.py },
    { lang: t('guideNode'), badge: 'openai · v4', code: s.node },
    { lang: t('guideCurl'), badge: 'REST', code: s.curl },
  ];

  return (
    <section id="guide" className="scroll-mt-20 py-20">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 lg:grid-cols-2">
        <div>
          <span className="inline-block rounded-full bg-[#3957ff]/10 px-3 py-1 text-xs font-medium text-[#3957ff]">
            {t('navGuide')}
          </span>
          <h2 className="mt-4 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">
            {t('guideTitle')}
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-slate-500">{t('guideSub')}</p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <CopyPill
              value={s.curl}
              label={t('guideCopyCmd')}
              copiedLabel={t('copiedBaseUrl')}
              className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-slate-700"
            />
            <Link
              href="/dashboard/api-guide"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 transition-colors hover:text-slate-900"
            >
              <Terminal className="size-4" />
              {t('guideBrowse')} →
            </Link>
          </div>
        </div>
        <div className="space-y-4 rounded-3xl bg-[#f5f7fb] p-8">
          {samples.map((sm) => (
            <div key={sm.lang} className="rounded-2xl border border-slate-100 bg-white p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="size-2 rounded-full bg-[#3957ff]" />
                <span className="text-sm font-medium text-slate-900">{sm.lang}</span>
                <span className="ml-auto text-[11px] text-slate-300">{sm.badge}</span>
              </div>
              <pre className="overflow-x-auto whitespace-pre font-mono text-[12px] leading-relaxed text-slate-600">
                {sm.code}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
