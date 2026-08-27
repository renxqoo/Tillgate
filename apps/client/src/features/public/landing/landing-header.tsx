import Link from 'next/link';
import { Plus } from 'lucide-react';

import type { MobileLink } from '@/features/public/mobile-menu';
import { MobileMenu } from '@/features/public/mobile-menu';
import { LandingLocaleToggle } from '@/features/auth/landing-locale-toggle';

import { LogoMark } from './logo-mark';
import type { LandingT } from './landing-shared';

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
