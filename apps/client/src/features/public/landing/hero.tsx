/**
 * 营销首页 · 头部 + Hero（复刻 skillhub.cn 大标题 + Base URL 接入条 + 核心能力轮播）。
 * 登录判断在 page.tsx：me 为 null 时展示「登录 / 免费开始」双按钮。
 */
import { Sparkles } from 'lucide-react';

import type { CarouselCard } from '@/features/public/hero-carousel';
import { HeroCarousel } from '@/features/public/hero-carousel';
import { CopyPill } from '@/features/public/copy-pill';

import type { LandingT } from './ui';

export { LandingHeader } from './landing-header';

export function LandingHero({
  t,
  base,
  cards,
}: {
  t: LandingT;
  base: string;
  cards: CarouselCard[];
}) {
  return (
    <section className="px-6 pt-16 md:pt-20">
      <div className="mx-auto max-w-5xl text-center">
        <h1 className="mx-auto text-4xl font-bold leading-[1.18] tracking-tight text-slate-900 md:text-5xl xl:text-6xl xl:leading-[1.12]">
          {t('heroTitlePre')}
          <Sparkles
            className="mx-1 inline-block size-[0.7em] fill-current stroke-none align-[-0.08em] text-[#3957ff]"
            aria-hidden
          />
          {t('heroTitlePost')}
        </h1>
        <p className="mt-6 text-base text-slate-500 md:text-lg">{t('heroDesc')}</p>

        <div className="mx-auto mt-10 flex max-w-[660px] items-center gap-3 rounded-full border border-slate-200 bg-white py-2 pl-6 pr-2 shadow-[0_12px_32px_rgba(15,23,42,0.08)]">
          <span className="hidden text-[13px] text-slate-400 sm:block">{t('baseUrlLabel')}</span>
          <code className="min-w-0 flex-1 truncate text-left font-mono text-[13px] font-medium text-slate-700">
            {base}
          </code>
          <CopyPill
            value={base}
            label={t('copyBaseUrl')}
            copiedLabel={t('copiedBaseUrl')}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-slate-900 px-5 py-2.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
          />
        </div>
      </div>

      <div className="mx-auto mt-14 max-w-6xl">
        <HeroCarousel cards={cards} prevLabel={t('carouselPrev')} nextLabel={t('carouselNext')} />
      </div>
    </section>
  );
}
