import { SearchIcon, TagIcon } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { Input } from '@tokenlens/ui';

import { Pager } from '@/features/shared/pager';
import { fetchPublicPricing } from '@/server/public-pricing';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/** 计价方式目录键（pricing 命名空间）；未知 unit 原样回显 */
const PRICING_UNIT_KEYS: Record<string, string> = {
  token: 'unitToken',
  request: 'unitRequest',
  image: 'unitImage',
  second: 'unitSecond',
  char: 'unitChar',
};

function fmtYuanPerMillion(price: string): string {
  const n = Number(price);
  if (!Number.isFinite(n) || n === 0) return '—';
  // 元/百万token 展示为 ¥/1M
  return `¥${n}`;
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('pricing');
  const fmtUnitPrice = (unit: string, price: string): string => {
    const n = Number(price);
    if (!Number.isFinite(n) || n === 0) return '—';
    const suffix = unit === 'request' ? t('perRequest') : unit === 'image' ? t('perImage') : unit === 'second' ? t('perSecond') : unit === 'char' ? t('perChar') : '';
    return `¥${n}${suffix}`;
  };

  const sp = await searchParams;
  const q = ((Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? '').trim();
  const page = Math.max(1, Number.parseInt((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? '1', 10) || 1);
  const data = await fetchPublicPricing({ q, page, pageSize: PAGE_SIZE });

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-8 flex items-center gap-3">
        <TagIcon className="size-7 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        {/* 原生 GET 搜索：提交即回第 1 页 */}
        <form method="GET" className="relative ml-auto">
          <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input name="q" defaultValue={q} placeholder={t('searchPlaceholder')} className="w-52 pl-9" />
        </form>
      </header>
      {data === null ? (
        <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colModel')}</th>
                  <th className="px-4 py-2 font-medium">{t('colBilling')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colInput')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colOutput')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colCacheHit')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colUnitPrice')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colContext')}</th>
                </tr>
              </thead>
              <tbody>
                {data.models.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="px-4 py-2 font-mono text-xs">
                      {m.externalName}
                      {m.isFree ? <span className="ml-2 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600">{t('freeBadge')}</span> : null}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {(() => {
                        const unitKey = PRICING_UNIT_KEYS[m.pricingUnit];
                        return unitKey ? t(unitKey) : m.pricingUnit;
                      })()}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {m.pricingUnit === 'token' ? fmtYuanPerMillion(m.inputPrice) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {m.pricingUnit === 'token' ? fmtYuanPerMillion(m.outputPrice) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {m.pricingUnit === 'token' ? fmtYuanPerMillion(m.cacheInputPrice) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {m.pricingUnit === 'token' ? '—' : fmtUnitPrice(m.pricingUnit, m.unitPrice)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-muted-foreground">
                      {m.contextLength ? `${Math.round(m.contextLength / 1000)}K` : '—'}
                    </td>
                  </tr>
                ))}
                {data.models.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      {t('noMatch', { q })}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <Pager page={page} totalPages={Math.max(1, Math.ceil(data.total / PAGE_SIZE))} searchParams={q ? { q } : {}} />
          </div>
        </>
      )}
      <p className="mt-6 text-sm text-muted-foreground">
        {t.rich('footer', {
          register: (chunks) => (
            <Link href="/register" className="underline">{chunks}</Link>
          ),
        })}
      </p>
    </main>
  );
}
