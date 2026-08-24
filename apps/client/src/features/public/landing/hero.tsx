/**
 * 营销首页 · 头部 + Hero（复刻 skillhub.cn 大标题 + Base URL 接入条 + 核心能力轮播）。
 * 登录判断在 page.tsx：me 为 null 时展示「登录 / 免费开始」双按钮。
 */
import Link from 'next/link';
import { Plus, Sparkles } from 'lucide-react';

import type { CarouselCard } from '@/features/public/hero-carousel';
import { HeroCarousel } from '@/features/public/hero-carousel';
import type { MobileLink } from '@/features/public/mobile-menu';
import { MobileMenu } from '@/features/public/mobile-menu';
import { CopyPill } from '@/features/public/copy-pill';
import { LandingLocaleToggle } from '@/features/auth/landing-locale-toggle';

import { LogoMark, type LandingT } from './ui';

export function LandingHeader({ t, me }: { t: LandingT; me: boolean }) {
  const startHref = me ? '/dashboard' : '/register';
  const links: MobileLink[] = [
    { href: '#models', label: t('navModels'), newBadge: true },
    { href: '#guide', label: t('navGuide') },
    { href: '#why', label: t('navWhy') },
    { href: '/pricing', label: t('navPricing') },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-slate-100 bg-white/90 backdrop-blur-md">
      <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2">
          <LogoMark className="size-6 text-[#3957ff]" />
          <span className="text-lg font-bold tracking-tight text-slate-900">Tillgate</span>
        </Link>
        <nav className="hidden items-center gap-7 text-sm font-medium text-slate-500 md:flex">
          <a href="#models" className="relative transition-colors hover:text-slate-900">
            {t('navModels')}
            <span className="absolute -right-3.5 -top-2 rounded bg-[#f64041] px-1 py-0.5 text-[9px] font-semibold leading-none text-white">
              {t('navNew')}
            </span>
          </a>
          <a href="#guide" className="transition-colors hover:text-slate-900">
            {t('navGuide')}
          </a>
          <a href="#why" className="transition-colors hover:text-slate-900">
            {t('navWhy')}
          </a>
          <Link href="/pricing" className="transition-colors hover:text-slate-900">
            {t('navPricing')}
          </Link>
        </nav>
        <div className="hidden items-center gap-3 md:flex">
          <LandingLocaleToggle />
          {me ? null : (
            <Link
              href="/login"
              className="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300"
            >
              {t('login')}
            </Link>
          )}
          <Link
            href={startHref}
            className="inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700"
          >
            <Plus className="size-4" />
            {me ? t('enterConsole') : t('startFree')}
          </Link>
        </div>
        <div className="relative flex items-center gap-2 md:hidden">
          <LandingLocaleToggle />
          <MobileMenu
            links={links}
            loggedIn={me}
            loginLabel={t('login')}
            enterLabel={t('enterConsole')}
            startLabel={t('startFree')}
          />
        </div>
      </div>
    </header>
  );
}

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
