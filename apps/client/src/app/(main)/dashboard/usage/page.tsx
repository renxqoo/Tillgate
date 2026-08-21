import { LineChartIcon } from 'lucide-react';

import { unitWord } from '@ai-gateway/api-client/formatters';
import {
  fmtDateTime,
  fmtCost,
  formatPoints,
  fmtInt,
  msToHuman,
  type UsageRow,
} from '@ai-gateway/api-client';
import { fetchUserList } from '@ai-gateway/api-client/list';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { firstParam, parseListSearchParams } from '@ai-gateway/ui/lib/list-query';
import { getLocale, getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UsagePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations('usage');
  const tCommon = await getTranslations('common');
  const locale = (await getLocale()) === 'zh' ? 'zh' : 'en';
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const model = firstParam(sp.model) ?? '';
  const { rows, total, error } = await fetchUserList<UsageRow>('/v1/usage', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q, model },
  });

  const columns: DataTableColumn<UsageRow>[] = [
    {
      key: 'createdAt',
      header: tCommon('time'),
      sortable: true,
      render: (r) => (
        <span className="text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
      ),
    },
    {
      key: 'externalModel',
      header: t('colModel'),
      render: (r) => (
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.externalModel}</code>
      ),
    },
    {
      key: 'source',
      header: t('colSource'),
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {r.credentialType === 'key' && r.keyName
            ? `🔑 ${r.keyName}`
            : r.credentialType === 'jwt' && r.appName
              ? `📦 ${r.appName}`
              : '—'}
        </span>
      ),
    },
    {
      key: 'inputTokens',
      header: t('colUsage'),
      align: 'right',
      render: (r) =>
        r.units && r.units > 0 ? (
          <span className="text-right tabular-nums">
            {fmtInt(r.units)} {unitWord(r.pricingUnit, locale)}
          </span>
        ) : (
          <span className="text-right tabular-nums">{fmtInt(r.inputTokens)}</span>
        ),
    },
    {
      key: 'cachedInputTokens',
      header: t('colCached'),
      align: 'right',
      render: (r) => (
        <span className="text-right tabular-nums text-muted-foreground">
          {r.units && r.units > 0
            ? '—'
            : r.cachedInputTokens > 0
              ? fmtInt(r.cachedInputTokens)
              : '—'}
        </span>
      ),
    },
    {
      key: 'cacheRate',
      header: t('colCacheRate'),
      align: 'right',
      render: (r) => (
        <span className="text-right tabular-nums text-muted-foreground">
          {r.units && r.units > 0
            ? '—'
            : r.inputTokens > 0
              ? `${((r.cachedInputTokens / r.inputTokens) * 100).toFixed(2)}%`
              : '—'}
        </span>
      ),
    },
    {
      key: 'outputTokens',
      header: t('colOutput'),
      align: 'right',
      render: (r) =>
        r.units && r.units > 0 ? (
          <span className="text-right tabular-nums text-muted-foreground">
            {r.unitPrice ? `¥${Number(r.unitPrice).toFixed(2)}/${unitWord(r.pricingUnit, locale)}` : '—'}
          </span>
        ) : (
          <span className="text-right tabular-nums">{fmtInt(r.outputTokens)}</span>
        ),
    },
    {
      key: 'amount',
      header: t('colCost'),
      sortable: true,
      align: 'right',
      render: (r) => (
        <span className="text-right font-medium tabular-nums">
          {r.billedBy === 'plan' ? (
            <>
              {formatPoints(r.planAmount).replace(/\.?0+$/, '')} {t('pointsUnit')}
              <span className="ml-1 text-xs text-muted-foreground">{t('billedPlan')}</span>
            </>
          ) : (
            <>
              ¥{fmtCost(r.paygAmount)}
              <span className="ml-1 text-xs text-muted-foreground">{t('billedBalance')}</span>
            </>
          )}
        </span>
      ),
    },
    {
      key: 'durationMs',
      header: t('colDuration'),
      sortable: true,
      align: 'right',
      render: (r) => (
        <span className="text-right tabular-nums text-muted-foreground">
          {msToHuman(r.durationMs)}
        </span>
      ),
    },
    {
      key: 'ttft',
      header: t('colTtft'),
      align: 'right',
      render: (r) => (
        <span className="text-right text-xs tabular-nums text-muted-foreground">
          {r.clientTtftMs != null ? `${(r.clientTtftMs / 1000).toFixed(2)}s` : '—'}
        </span>
      ),
    },
  ];

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <ListPage
        title={t('title')}
        icon={<LineChartIcon className="size-5 text-muted-foreground" />}
        total={total}
        totalUnit={t('totalUnit')}
        searchPlaceholder={t('searchPlaceholder')}
        q={q}
        searchParams={{ q, model, sort_by: sortBy, order: sortBy ? order : undefined }}
        error={error}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          sort={{ sortBy, order }}
          searchParams={{ q, model }}
          empty={t('empty')}
        />
      </ListPage>
    </div>
  );
}
