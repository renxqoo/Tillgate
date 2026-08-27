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
  type DisplayLocale,
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

// —— 模块级 cell 渲染函数：列 cell 若内联 JSX 会被判定为渲染期定义组件
// （react/no-unstable-nested-components），统一提为模块级小函数返回 ReactNode ——

function renderTimeCell(r: UsageRow, locale: DisplayLocale) {
  return (
    <span className="text-xs text-muted-foreground">{formatDateTime(r.createdAt, locale)}</span>
  );
}

function renderModelCell(r: UsageRow) {
  return <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.externalModel}</code>;
}

/** 来源列：API Key / OAuth 应用凭据，取不到时降级 — */
function renderSourceCell(r: UsageRow) {
  return (
    <span className="text-xs text-muted-foreground">
      {r.credentialType === 'key' && r.keyName
        ? `🔑 ${r.keyName}`
        : r.credentialType === 'jwt' && r.appName
          ? `📦 ${r.appName}`
          : '—'}
    </span>
  );
}

/** 用量列：计费单位制（units）优先，否则回退 input tokens */
function renderUsageCell(r: UsageRow, locale: DisplayLocale) {
  if (r.units && r.units > 0) {
    return (
      <span className="text-right tabular-nums">
        {formatInt(r.units)} {unitWord(r.pricingUnit, locale)}
      </span>
    );
  }
  return <span className="text-right tabular-nums">{formatInt(r.inputTokens)}</span>;
}

/** 缓存命中列：单位制无 token 口径，正数才展示 */
function cachedCellText(r: UsageRow): string {
  if (r.units && r.units > 0) return '—';
  if (r.cachedInputTokens > 0) return formatInt(r.cachedInputTokens);
  return '—';
}

function renderCachedCell(r: UsageRow) {
  return <span className="text-right tabular-nums text-muted-foreground">{cachedCellText(r)}</span>;
}

function cacheRateCellText(r: UsageRow): string {
  if (r.units && r.units > 0) return '—';
  if (r.inputTokens > 0) {
    return `${((r.cachedInputTokens / r.inputTokens) * 100).toFixed(2)}%`;
  }
  return '—';
}

function renderCacheRateCell(r: UsageRow) {
  return (
    <span className="text-right tabular-nums text-muted-foreground">{cacheRateCellText(r)}</span>
  );
}

/** 输出列：单位制展示单价，token 制展示输出 tokens */
function renderOutputCell(r: UsageRow, locale: DisplayLocale) {
  if (r.units && r.units > 0) {
    return (
      <span className="text-right tabular-nums text-muted-foreground">
        {r.unitPrice
          ? `${formatMoney(r.unitPrice, locale)}/${unitWord(r.pricingUnit, locale)}`
          : '—'}
      </span>
    );
  }
  return <span className="text-right tabular-nums">{formatInt(r.outputTokens)}</span>;
}

/** 金额列：plan 计费金额直接展示（不做 ×100 积分投影） */
function renderAmountCell(
  r: UsageRow,
  locale: DisplayLocale,
  labels: { plan: string; balance: string },
) {
  return (
    <span className="text-right font-medium tabular-nums">
      {r.billedBy === 'plan' ? (
        <>
          {formatMoney(r.planAmount, locale)}
          <span className="ml-1 text-xs text-muted-foreground">{labels.plan}</span>
        </>
      ) : (
        <>
          {formatMoney(r.paygAmount, locale)}
          <span className="ml-1 text-xs text-muted-foreground">{labels.balance}</span>
        </>
      )}
    </span>
  );
}

function renderDurationCell(r: UsageRow) {
  return (
    <span className="text-right tabular-nums text-muted-foreground">{msToHuman(r.durationMs)}</span>
  );
}

function renderTtftCell(r: UsageRow) {
  return (
    <span className="text-right text-xs tabular-nums text-muted-foreground">
      {r.clientTtftMs != null ? `${(r.clientTtftMs / 1000).toFixed(2)}s` : '—'}
    </span>
  );
}

export default async function UsagePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations('usage');
  const tCommon = await getTranslations('common');
  const locale = (await getLocale()) === 'zh' ? 'zh' : 'en';
  const { page } = parseListSearchParams(sp);
  // 契约过滤集：model + from/to 时间窗（无 q 搜索与列排序）
  const model = (firstParam(sp.model) ?? '').trim();
  const from = firstParam(sp.from);
  const to = firstParam(sp.to);
  const api = createClientApi();
  await requireMe(api);

  let rows: UsageRow[] = [];
  let total = 0;
  let loadError: string | null = null;
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
    // catch 形参按 catch-error-name 规则命名为 error，外层改名为 loadError：原写法
    // 赋给了 catch 参数导致外层恒为 null，加载失败提示永不上屏——真实 bug 一并修复
    ({ rows, total } = result);
  } catch (error) {
    loadError = error instanceof ApiError ? error.message : t('loadFailed');
  }

  const columns: DataTableColumn<UsageRow>[] = [
    {
      key: 'createdAt',
      header: tCommon('time'),
      cell: (r) => renderTimeCell(r, locale),
    },
    {
      key: 'externalModel',
      header: t('colModel'),
      cell: (r) => renderModelCell(r),
    },
    {
      key: 'source',
      header: t('colSource'),
      cell: (r) => renderSourceCell(r),
    },
    {
      key: 'inputTokens',
      header: t('colUsage'),
      align: 'right',
      cell: (r) => renderUsageCell(r, locale),
    },
    {
      key: 'cachedInputTokens',
      header: t('colCached'),
      align: 'right',
      cell: (r) => renderCachedCell(r),
    },
    {
      key: 'cacheRate',
      header: t('colCacheRate'),
      align: 'right',
      cell: (r) => renderCacheRateCell(r),
    },
    {
      key: 'outputTokens',
      header: t('colOutput'),
      align: 'right',
      cell: (r) => renderOutputCell(r, locale),
    },
    {
      key: 'amount',
      header: t('colCost'),
      align: 'right',
      cell: (r) =>
        renderAmountCell(r, locale, { plan: t('billedPlan'), balance: t('billedBalance') }),
    },
    {
      key: 'durationMs',
      header: t('colDuration'),
      align: 'right',
      cell: (r) => renderDurationCell(r),
    },
    {
      key: 'ttft',
      header: t('colTtft'),
      align: 'right',
      cell: (r) => renderTtftCell(r),
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
        error={loadError}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} empty={t('empty')} />
      </ListPage>
    </div>
  );
}
