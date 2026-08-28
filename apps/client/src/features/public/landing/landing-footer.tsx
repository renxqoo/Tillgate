import Link from 'next/link';

import { APP_CONFIG } from '@/config/app-config';

import { LogoMark } from './logo-mark';
import type { LandingT } from './landing-shared';

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
            <span className="font-bold tracking-tight text-slate-900">Tillgate</span>
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
