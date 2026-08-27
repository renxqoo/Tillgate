import Link from 'next/link';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import {
  Activity,
  ArrowRight,
  LayoutDashboard,
  Network,
  Route,
  ScanEye,
  UserRound,
  Wallet,
} from 'lucide-react';

import { LandingLocaleToggle } from '@/components/landing/locale-toggle';

import { LandingFeatures } from './landing-features';
import { LandingStack } from './landing-stack';

/** 落地页独立于后台的标题/描述（覆盖根布局的 Studio Admin 模板） */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('landing');
  return {
    title: { absolute: `Tillgate — ${t('heroTitle')}` },
    description: t('heroDescription'),
  };
}

/**
 * 产品落地页（简洁亮色 SaaS 风）：白底无杂色，品牌蓝点缀，
 * 结构为 导航 → hero(标题/CTA/产品大图) → 产品能力 → 技术架构 → CTA → 页脚。
 * 产品大图按语言取 /image-zh-cn.png 或 /image-en.png（用户提供的清晰截图）。
 */
export default async function Landing() {
  const locale = await getLocale();
  const t = await getTranslations('landing');
  const heroImage = locale === 'zh' ? '/image-zh-cn.png' : '/image-en.png';

  const features = [
    { icon: Network, title: t('f1Title'), description: t('f1Description') },
    { icon: Route, title: t('f2Title'), description: t('f2Description') },
    { icon: Wallet, title: t('f3Title'), description: t('f3Description') },
    { icon: Activity, title: t('f4Title'), description: t('f4Description') },
    { icon: LayoutDashboard, title: t('f5Title'), description: t('f5Description') },
    { icon: UserRound, title: t('f6Title'), description: t('f6Description') },
  ];

  const stack = [
    'Next.js 16',
    'Hono',
    'PostgreSQL',
    'Redis',
    'OpenTelemetry',
    'Docker',
    'Turborepo',
    'Bun',
  ];

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      {/* ── 头部导航 ─────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-border/70 bg-background/80 backdrop-blur">
        <nav className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <a href="/" aria-label="Tillgate homepage" className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ScanEye className="size-4" />
            </span>
            <span className="text-base font-semibold tracking-tight">Tillgate</span>
          </a>

          <div className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
            <a href="#features" className="transition hover:text-foreground">
              {t('navFeatures')}
            </a>
            <a href="#stack" className="transition hover:text-foreground">
              {t('navStack')}
            </a>
          </div>

          <div className="flex items-center gap-3">
            <LandingLocaleToggle />
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              {t('navConsole')}
            </Link>
          </div>
        </nav>
      </header>

      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="mx-auto w-full max-w-6xl px-6 pb-16 pt-16 sm:pb-20 sm:pt-20">
        <div className="flex flex-col items-center gap-5 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-4 py-1.5 text-xs font-medium text-muted-foreground">
            <span aria-hidden="true">🎉</span>
            {t('announcement')}
          </span>

          <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            {t('heroTitle')}
          </h1>
          <p className="max-w-2xl text-base text-muted-foreground sm:text-lg">
            {t('heroDescription')}
          </p>

          <div className="mt-3 flex flex-col items-center gap-4 sm:flex-row">
            <Link
              href="/login"
              className="inline-flex items-center gap-2 rounded-full bg-primary px-7 py-3 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
            >
              {t('ctaPrimary')}
              <ArrowRight className="size-4" />
            </Link>
            <a
              href="#features"
              className="text-sm text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
            >
              {t('ctaSecondary')}
            </a>
          </div>

          {/* 产品大图：按语言切换中/英截图 */}
          <div className="mt-12 w-full overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.10)]">
            <img src={heroImage} alt={t('heroImageAlt')} className="h-auto w-full" />
          </div>
        </div>
      </section>

      <LandingFeatures t={t} features={features} />

      <LandingStack t={t} stack={stack} />

      {/* ── 底部 CTA ─────────────────────────────────────────── */}
      <section className="border-t border-border/60 py-16 sm:py-20">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 px-6 text-center">
          <h2 className="text-3xl font-semibold tracking-tight">{t('ctaBandTitle')}</h2>
          <p className="max-w-2xl text-muted-foreground">{t('ctaBandDescription')}</p>
          <Link
            href="/login"
            className="mt-2 inline-flex items-center gap-2 rounded-full bg-primary px-8 py-3 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            {t('ctaBandAction')}
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      {/* ── 页脚 ─────────────────────────────────────────────── */}
      <footer className="border-t border-border/60 py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-6 text-sm text-muted-foreground sm:flex-row">
          <span>{t('footerCopyright')}</span>
          <span>{t('footerLicense')}</span>
        </div>
      </footer>
    </div>
  );
}
