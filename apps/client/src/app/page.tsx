/**
 * 营销首页（复刻 skillhub.cn：大标题 Hero + 能力轮播 + 免费榜单 + 接入指南
 * + Tabs 信任区 + 计费/供应商/CTA + 页脚）。
 * 数据与功能全部走现有接口：登录态 getMe、公开定价 /v1/pricing（免费榜单）、
 * 复制 Base URL / 接入命令、以及指向控制台各页的真实跳转。
 */
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';

import type { CarouselCard } from '@/features/public/hero-carousel';
import { LandingHeader, LandingHero } from '@/features/public/landing/hero';
import { GuideSection, ModelsBoard } from '@/features/public/landing/showcase';
import {
  BillingSection,
  CtaSection,
  LandingFooter,
  SUPPLIERS,
  SuppliersSection,
  WhySection,
} from '@/features/public/landing/trust';
import type { WhyTabData } from '@/features/public/why-tabs';
import { fetchPublicPricing } from '@/server/public-pricing';
import { optionalMe } from '@/server/session';

export const dynamic = 'force-dynamic';

/** 当前部署的站点地址（示例与徽章同源，复制即用）：反代场景取 x-forwarded-host */
function siteOrigin(h: Headers): string {
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3001';
  const proto =
    h.get('x-forwarded-proto') ??
    (/^(localhost|127\.|192\.168\.|10\.)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

function contextLabel(t: Awaited<ReturnType<typeof getTranslations>>, n: number | null) {
  return n ? ` · ${t('boardContext', { n: Math.round(n / 1000) })}` : '';
}

export default async function Landing() {
  const t = await getTranslations('landing');
  const tPricing = await getTranslations('pricing');

  // 登录态 + 模型目录：榜单与轮播同源（免费前 9），统计用目录总数
  const [me, freePage, allPage] = await Promise.all([
    optionalMe(),
    fetchPublicPricing({ free: true, pageSize: 9 }),
    fetchPublicPricing({ pageSize: 1 }),
  ]);
  const showcase = freePage?.models ?? [];
  const freeCount = freePage?.total ?? showcase.filter((m) => m.isFree).length;
  const total = allPage?.total ?? freePage?.total ?? showcase.length;
  const startHref = me ? '/dashboard' : '/register';
  const origin = siteOrigin(await headers());
  const base = `${origin}/v1`;

  const cards: CarouselCard[] = [
    {
      href: '/pricing',
      eyebrow: t('cardModelsEyebrow'),
      title: t('cardModelsTitle'),
      sub: t('cardModelsSub'),
      theme: 'models',
      freeChip: t('boardFree'),
      featuredLabel: t('cardModelsFeatured'),
      models: showcase.slice(0, 3).map((m) => ({
        name: m.externalName,
        contextLabel: contextLabel(t, m.contextLength).replace(' · ', ''),
      })),
    },
    {
      href: '/dashboard/api-guide',
      eyebrow: t('cardApiEyebrow'),
      title: t('cardApiTitle'),
      sub: t('cardApiSub'),
      theme: 'api',
      host: t('cardApiHost'),
    },
    {
      href: '/dashboard/usage',
      eyebrow: t('cardUsageEyebrow'),
      title: t('cardUsageTitle'),
      sub: t('cardUsageSub'),
      theme: 'usage',
      exampleLabel: t('cardUsageExample'),
      stats: [
        { label: t('cardUsageCalls'), value: t('cardUsageCallsValue') },
        { label: t('cardUsageSpend'), value: t('cardUsageSpendValue') },
      ],
    },
    {
      href: '/dashboard/billing',
      eyebrow: t('cardWalletEyebrow'),
      title: t('cardWalletTitle'),
      sub: t('cardWalletSub'),
      theme: 'wallet',
      stats: [
        { label: t('cardWalletBalance'), value: t('cardWalletBalanceValue') },
        { label: t('cardWalletRecharge'), value: t('cardWalletRechargeValue') },
        { label: t('cardWalletBills'), value: t('cardWalletBillsValue') },
      ],
    },
  ];

  const whyPersonal: WhyTabData = {
    title: t('whyPersonalTitle'),
    text: t('whyPersonalText'),
    items: t.raw('whyPersonalItems') as string[],
    stats: [
      { value: String(freeCount), label: t('whyStatFree') },
      { value: String(total), label: t('whyStatTotal') },
      { value: String(SUPPLIERS.length), label: t('whyStatProviders') },
      { value: '100%', label: t('whyStatCompatible') },
    ],
    ctaLabel: t('whyCtaFree'),
    ctaHref: startHref,
  };
  const whyOrg: WhyTabData = {
    title: t('whyOrgTitle'),
    text: t('whyOrgText'),
    items: t.raw('whyOrgItems') as string[],
    stats: [
      { value: String(total), label: t('whyStatTotal') },
      { value: String(SUPPLIERS.length), label: t('whyStatProviders') },
      { value: '100%', label: t('whyStatCompatible') },
      { value: String(freeCount), label: t('whyStatFree') },
    ],
    ctaLabel: t('whyCtaConsole'),
    ctaHref: '/dashboard',
  };

  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased">
      <LandingHeader t={t} me={!!me} />
      <main>
        <LandingHero t={t} base={base} cards={cards} />
        <ModelsBoard
          t={t}
          tPricing={tPricing}
          featured={showcase[0]}
          ranks={showcase.slice(1, 9)}
        />
        <GuideSection t={t} base={base} />
        <WhySection
          t={t}
          tabA={whyPersonal}
          tabB={whyOrg}
          stats={[
            { value: String(freeCount), label: t('statsFree') },
            { value: String(total), label: t('statsTotal') },
            { value: String(SUPPLIERS.length), label: t('statsProviders') },
            { value: '1', label: t('statsOneKeyLabel') },
          ]}
        />
        <BillingSection t={t} />
        <SuppliersSection t={t} />
        <CtaSection t={t} startHref={startHref} />
      </main>
      <LandingFooter t={t} />
    </div>
  );
}
