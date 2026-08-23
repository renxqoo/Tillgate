/**
 * 营销首页共用小块（复刻 skillhub.cn 风格的黑白灰 + #3957ff 主题）。
 * 无状态服务端组件：文案由 page.tsx 注入，保证所有 section 可单独编译。
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Sparkles } from 'lucide-react';

export type LandingT = Awaited<ReturnType<typeof getTranslations<'landing'>>>;
export type PricingT = Awaited<ReturnType<typeof getTranslations<'pricing'>>>;

/** 品牌星形标记 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center justify-center ${className ?? ''}`}>
      <Sparkles className="h-full w-full" aria-hidden />
    </span>
  );
}

export function BlackPill({
  href,
  children,
  className = '',
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 rounded-full bg-slate-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-slate-700 ${className}`}
    >
      {children}
    </Link>
  );
}

export function OutlinePill({
  href,
  children,
  className = '',
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-6 py-3 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-900 ${className}`}
    >
      {children}
    </Link>
  );
}

/** 区块头：chip + 标题 + 副文案（居中） */
export function SectionHeading({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: string;
  sub: string;
}) {
  return (
    <div className="mx-auto mb-12 max-w-2xl space-y-4 text-center">
      <span className="inline-block rounded-full bg-[#3957ff]/10 px-3 py-1 text-xs font-medium text-[#3957ff]">
        {eyebrow}
      </span>
      <h2 className="text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">{title}</h2>
      <p className="text-[15px] leading-relaxed text-slate-500">{sub}</p>
    </div>
  );
}

/** 数字价展示：元/百万 Token 口径 */
export function fmtPrice(price: string): string {
  const n = Number(price);
  if (!Number.isFinite(n) || n === 0) return '—';
  return `¥${String(Number(n.toFixed(4)))}`;
}

/** 计价方式目录键（pricing 命名空间）；未知 unit 原样回显 */
const PRICING_UNIT_KEYS: Record<string, string> = {
  token: 'unitToken',
  request: 'unitRequest',
  image: 'unitImage',
  second: 'unitSecond',
  char: 'unitChar',
};

export function formatUnit(tPricing: PricingT, unit: string): string {
  const unitKey = PRICING_UNIT_KEYS[unit];
  return unitKey ? tPricing(unitKey) : unit;
}
