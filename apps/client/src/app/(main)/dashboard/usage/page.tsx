import { LineChartIcon } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { ApiError, type UsageRow } from '@tillgate/api-client';
import { DataTable, Input, Button, type DataTableColumn } from '@tillgate/ui';

import {
  formatDateTime,
  formatMoney,
  formatInt,
  msToHuman,
  unitWord,
} from '@/features/shared/format';
import { ListPage } from '@/features/shared/list-page';
import { firstParam, parseListSearchParams } from '@/server/list-query';
import { createClientApi } from '@/server/api';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** from/to 日期（yyyy-MM-dd）→ ISO datetime（后端 zod .datetime() 契约） */
function dayToIso(day: string | undefined, endOfDay: boolean): string | undefined {
  if (!day) return undefined;
  const t = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  return `${day}${t}`;
}

export default async function UsagePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations('usage');
  const tCommon = await getTranslations('common');
  const locale = (await getLocale()) === 'zh' ? 'zh' : 'en';
  const { page } = parseListSearchParams(sp);
  // 契约过滤集（D-B）：model + from/to 时间窗（v1 的 q 搜索/列排序随 strict 契约移除——G1）
  const model = (firstParam(sp.model) ?? '').trim();
  const from = firstParam(sp.from);
  const to = firstParam(sp.to);
  const api = createClientApi();
  await requireMe(api);

  let rows: UsageRow[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    const result = await api.list<UsageRow>('/v1/usage', {
      page,
      pageSize: PAGE_SIZE,
      extra: {
        model: model || undefined,
        from: dayToIso(from, false),
        to: dayToIso(to, true),
      },
    });
    rows = result.rows;
    total = result.total;
  } catch (e) {
    error = e instanceof ApiError ? e.message : t('loadFailed');
  }

  const columns: DataTableColumn<UsageRow>[] = [
    {
      key: 'createdAt',
      header: tCommon('time'),
      cell: (r) => (
        <span className="text-xs text-muted-foreground">{formatDateTime(r.createdAt, locale)}</span>
      ),
    },
    {
      key: 'externalModel',
      header: t('colModel'),
      cell: (r) => (
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.externalModel}</code>
      ),
    },
    {
      key: 'source',
      header: t('colSource'),
      cell: (r) => (
        <span className="text-xs text-muted-foreground">
          {(() => {
            if (r.credentialType === 'key' && r.keyName) return `🔑 ${r.keyName}`;
            if (r.credentialType === 'jwt' && r.appName) return `📦 ${r.appName}`;
            return '—';
          })()}
        </span>
      ),
    },
    {
      key: 'inputTokens',
      header: t('colUsage'),
      align: 'right',
      cell: (r) =>
        r.units && r.units > 0 ? (
          <span className="text-right tabular-nums">
            {formatInt(r.units)} {unitWord(r.pricingUnit, locale)}
          </span>
        ) : (
          <span className="text-right tabular-nums">{formatInt(r.inputTokens)}</span>
        ),
    },
    {
      key: 'cachedInputTokens',
      header: t('colCached'),
      align: 'right',
      cell: (r) => (
        <span className="text-right tabular-nums text-muted-foreground">
          {(() => {
            if (r.units && r.units > 0) return '—';
            if (r.cachedInputTokens > 0) return formatInt(r.cachedInputTokens);
            return '—';
          })()}
        </span>
      ),
    },
    {
      key: 'cacheRate',
      header: t('colCacheRate'),
      align: 'right',
      cell: (r) => (
        <span className="text-right tabular-nums text-muted-foreground">
          {(() => {
            if (r.units && r.units > 0) return '—';
            if (r.inputTokens > 0)
              return `${((r.cachedInputTokens / r.inputTokens) * 100).toFixed(2)}%`;
            return '—';
          })()}
        </span>
      ),
    },
    {
      key: 'outputTokens',
      header: t('colOutput'),
      align: 'right',
      cell: (r) =>
        r.units && r.units > 0 ? (
          <span className="text-right tabular-nums text-muted-foreground">
            {r.unitPrice
              ? `${formatMoney(r.unitPrice, locale)}/${unitWord(r.pricingUnit, locale)}`
              : '—'}
          </span>
        ) : (
          <span className="text-right tabular-nums">{formatInt(r.outputTokens)}</span>
        ),
    },
    {
      key: 'amount',
      header: t('colCost'),
      align: 'right',
      cell: (r) => (
        <span className="text-right font-medium tabular-nums">
          {/* plan 计费金额展示口径随 D-E 简化：直接金额展示（v1 ×100 积分投影废除） */}
          {r.billedBy === 'plan' ? (
            <>
              {formatMoney(r.planAmount, locale)}
              <span className="ml-1 text-xs text-muted-foreground">{t('billedPlan')}</span>
            </>
          ) : (
            <>
              {formatMoney(r.paygAmount, locale)}
              <span className="ml-1 text-xs text-muted-foreground">{t('billedBalance')}</span>
            </>
          )}
        </span>
      ),
    },
    {
      key: 'durationMs',
      header: t('colDuration'),
      align: 'right',
      cell: (r) => (
        <span className="text-right tabular-nums text-muted-foreground">
          {msToHuman(r.durationMs)}
        </span>
      ),
    },
    {
      key: 'ttft',
      header: t('colTtft'),
      align: 'right',
      cell: (r) => (
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
        searchParams={{
          model: model || undefined,
          from,
          to,
          page: page > 1 ? String(page) : undefined,
        }}
        filters={
          <form method="GET" className="flex flex-wrap items-center gap-2">
            <Input
              name="model"
              defaultValue={model}
              placeholder={t('filterModel')}
              className="w-44"
            />
            <Input
              type="date"
              name="from"
              defaultValue={from}
              aria-label={t('filterFrom')}
              className="w-36"
            />
            <Input
              type="date"
              name="to"
              defaultValue={to}
              aria-label={t('filterTo')}
              className="w-36"
            />
            <Button type="submit" variant="outline" size="sm">
              {t('filterApply')}
            </Button>
          </form>
        }
        error={error}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} empty={t('empty')} />
      </ListPage>
    </div>
  );
}
