import type { ReactNode } from 'react';

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { Alert, AlertDescription, Badge, Button, Input } from '@tillgate/ui';

import { PricingTable } from '@/features/pricing/pricing-table';
import { LandingFooter } from '@/features/public/landing/landing-footer';
import { LandingHeader } from '@/features/public/landing/landing-header';
import { Pager } from '@/features/shared/pager';
import { listHref } from '@/server/list-query';
import { fetchPublicPricing } from '@/server/public-pricing';
import { optionalMe } from '@/server/session';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/** t.rich 的 register 富文本渲染：指向注册页（模块级——避免渲染期定义组件） */
function renderRegisterLink(chunks: ReactNode) {
  return (
    <Link href="/register" className="font-medium text-slate-900 underline underline-offset-2">
      {chunks}
    </Link>
  );
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('pricing');
  const tLanding = await getTranslations('landing');
  const tUi = await getTranslations('ui');

  const sp = await searchParams;
  const q = ((Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? '').trim();
  const page = Math.max(
    1,
    Number.parseInt((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? '1', 10) || 1,
  );

  // 登录态只影响导航按钮形态（进控制台 / 登录），取数失败按未登录处理
  const [data, me] = await Promise.all([
    fetchPublicPricing({ q, page, pageSize: PAGE_SIZE }),
    optionalMe(),
  ]);

  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased">
      <LandingHeader t={tLanding} me={!!me} anchorPrefix="/" />
      <main className="mx-auto max-w-6xl px-6 py-14">
        <header className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-xl">
            <Badge variant="outline" className="border-slate-200 text-slate-500 hover:bg-slate-50">
              {t('eyebrow')}
            </Badge>
            <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{t('title')}</h1>
            <p className="mt-3 text-sm leading-relaxed text-slate-500">{t('subtitle')}</p>
          </div>
          <div className="w-full shrink-0 lg:max-w-md">
            {/* 原生 GET 搜索：提交即回第 1 页（page 不带进表单） */}
            <form method="GET" className="flex items-center gap-2">
              <Input
                name="q"
                defaultValue={q}
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchPlaceholder')}
                className="h-10 w-full rounded-xl bg-slate-50 pl-9"
              />
              <Button type="submit" className="h-10 shrink-0 rounded-xl px-4">
                {tUi('search')}
              </Button>
              {q ? (
                <Button
                  variant="ghost"
                  className="h-10 shrink-0 rounded-xl px-3 text-slate-500"
                  render={<a href={listHref({}, { q: undefined, page: undefined })} />}
                  aria-label={tUi('clearSearch')}
                >
                  {tUi('clearSearch')}
                </Button>
              ) : null}
            </form>
            {data ? (
              <p className="mt-3 text-xs text-slate-400">
                {t('resultCount', { count: data.total })}
              </p>
            ) : null}
          </div>
        </header>

        {data === null ? (
          <Alert variant="destructive" className="mt-10 rounded-xl">
            <AlertDescription>{t('unavailable')}</AlertDescription>
          </Alert>
        ) : data.models.length === 0 ? (
          <div className="mt-10 rounded-xl border border-slate-100 bg-slate-50/60 py-16 text-center">
            <p className="text-sm text-slate-500">{t('noMatch', { q })}</p>
          </div>
        ) : (
          <>
            <div className="mt-10 overflow-hidden rounded-2xl border border-slate-100">
              <PricingTable models={data.models} t={t} />
            </div>
            <div className="mt-6 flex flex-col items-center gap-3">
              <Pager
                page={page}
                totalPages={Math.max(1, Math.ceil(data.total / PAGE_SIZE))}
                searchParams={q ? { q } : {}}
                align="center"
              />
              {data.billingTimezone ? (
                <p className="text-xs text-slate-400">
                  {t('scheduleTimezoneNote', { timezone: data.billingTimezone })}
                </p>
              ) : null}
            </div>
          </>
        )}

        <p className="mt-12 text-sm text-slate-500">
          {t.rich('footer', { register: (chunks) => renderRegisterLink(chunks) })}
        </p>
      </main>
      <LandingFooter t={tLanding} anchorPrefix="/" />
    </div>
  );
}
