import { requirePermission } from '@/server/get-admin';
import type { DataTableColumn } from '@/components/data-table';

import { DataTable } from '@/components/data-table';
import { CoinsIcon } from 'lucide-react';

import { getLocale, getTranslations } from 'next-intl/server';
import { unitWord } from '@/lib/formatters';
import { ApiError } from '@tillgate/api-client';
import type { AdminUsageRow, Paginated } from '@tillgate/api-client';
import { fmtDateTime } from '@/lib/formatters';
import { msToHuman } from '@/lib/formatters';
import { adminApi } from '@/server/admin-api';
import { ListPage } from '@/components/list-page';
import { firstParam, parseListSearchParams } from '@/lib/list-query';

import { UsageLogsFilter } from '@/features/tracing/usage-logs-filter';

export const dynamic = 'force-dynamic';

/** ms → 秒展示（两位小数；null = 无样本） */
const ttftSec = (ms: number | null | undefined) =>
  ms != null ? `${(ms / 1000).toFixed(2)}s` : '—';

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** 估算归属 → 可读文案（管理端观测：这笔为什么按估算扣）；label 为 usageLogs 命名空间 key */
function estimateReasonKey(reason: string | null): string {
  switch (reason) {
    case 'client_disconnect':
    case 'request_cancelled':
    case 'aborted': {
      return 'reasonCancelled';
    }
    case 'usage_missing_completed': {
      return 'reasonMissingCompleted';
    }
    case 'usage_missing_nonstream': {
      return 'reasonMissingNonstream';
    }
    default: {
      return 'reasonDefault';
    }
  }
}

/** 用量表列定义（cell 渲染器随列声明平铺；t/tc/locale 经参数传入） */
function buildUsageColumns(
  t: Awaited<ReturnType<typeof getTranslations<'usageLogs'>>>,
  tc: Awaited<ReturnType<typeof getTranslations<'common'>>>,
  locale: 'en' | 'zh',
): DataTableColumn<AdminUsageRow>[] {
  return [
    {
      key: 'requestId',
      header: 'Request ID',
      render: (r) => (
        <code className="text-xs text-muted-foreground">{r.requestId.slice(0, 8)}</code>
      ),
    },
    {
      key: 'userName',
      header: tc('user'),
      render: (r) => (
        <span className="text-xs">{r.userName ?? (r.userId ? `#${r.userId}` : '—')}</span>
      ),
    },
    {
      key: 'externalModel',
      header: t('model'),
      render: (r) => (
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.externalModel}</code>
      ),
    },
    {
      key: 'inputTokens',
      header: t('input'),
      sortable: true,
      align: 'right',
      render: (r) =>
        r.units && r.units > 0 ? (
          <span className="text-right text-xs tabular-nums">
            {r.units.toLocaleString('en-US')} {unitWord(r.pricingUnit, locale)}
            <span className="ml-1 text-muted-foreground">{t('unitPricing')}</span>
          </span>
        ) : (
          <span className="text-right text-xs tabular-nums">
            {r.inputTokens.toLocaleString('en-US')}
            {r.cachedInputTokens > 0 ? (
              <span className="ml-1 text-muted-foreground">
                {t('cached', { count: r.cachedInputTokens.toLocaleString('en-US') })}
              </span>
            ) : null}
          </span>
        ),
    },
    {
      key: 'outputTokens',
      header: t('output'),
      sortable: true,
      align: 'right',
      render: (r) =>
        r.units && r.units > 0 ? (
          <span className="text-right text-xs tabular-nums text-muted-foreground">
            {r.unitPrice
              ? `¥${Number(r.unitPrice).toFixed(2)}/${unitWord(r.pricingUnit, locale)}`
              : '—'}
          </span>
        ) : (
          <span className="text-right text-xs tabular-nums">
            {r.outputTokens.toLocaleString('en-US')}
          </span>
        ),
    },
    {
      key: 'amount',
      header: t('charge'),
      sortable: true,
      align: 'right',
      render: (r) => (
        <span className="text-right text-xs font-medium tabular-nums">
          ¥{Number(r.amount).toFixed(6)}
          {r.estimated ? (
            <span
              title={t(estimateReasonKey(r.estimateReason))}
              className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] leading-4 text-amber-700 dark:text-amber-300"
            >
              {t('estimatedBadge')}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'billedBy',
      header: t('source'),
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {r.billedBy === 'plan' ? t('plan') : t('balance')}
        </span>
      ),
    },
    {
      key: 'durationMs',
      header: t('duration'),
      sortable: true,
      align: 'right',
      render: (r) => (
        <span className="text-right text-xs tabular-nums text-muted-foreground">
          {msToHuman(r.durationMs)}
        </span>
      ),
    },
    {
      key: 'ttft',
      header: t('ttft'),
      align: 'right',
      render: (r) => (
        <span className="text-right text-xs tabular-nums text-muted-foreground">
          {r.upstreamTtftMs != null || r.clientTtftMs != null
            ? `${ttftSec(r.upstreamTtftMs)}/${ttftSec(r.clientTtftMs)}`
            : '—'}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: tc('time'),
      sortable: true,
      headerClassName: 'w-44',
      render: (r) => (
        <span className="text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
      ),
    },
  ];
}

export default async function UsageLogsPage({ searchParams }: PageProps) {
  await requirePermission('ops:read');
  const sp = await searchParams;
  const t = await getTranslations('usageLogs');
  const tc = await getTranslations('common');
  const locale = (await getLocale()) as 'en' | 'zh';
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const from = firstParam(sp.from) ?? '';
  const to = firstParam(sp.to) ?? '';
  const userId = firstParam(sp.userId) ?? '';
  const estimated = firstParam(sp.estimated) ?? '';
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(PAGE_SIZE),
    sort_by: sortBy ?? 'createdAt',
    order,
  });
  // 非空筛选统一并入 query（q/from/to/userId/estimated）
  for (const [key, value] of Object.entries({ q, from, to, userId, estimated })) {
    if (value) query.set(key, value);
  }

  let rows: AdminUsageRow[] = [];
  let total = 0;
  let loadError: string | null = null;
  try {
    const data = await adminApi().get<Paginated<AdminUsageRow>>(
      `/v1/usage-logs?${query.toString()}`,
    );
    rows = data.rows ?? [];
    total = data.total ?? 0;
  } catch (error) {
    loadError = error instanceof ApiError ? error.message : tc('loadFailed');
  }

  const columns = buildUsageColumns(t, tc, locale);

  return (
    <ListPage
      title={t('title')}
      icon={<CoinsIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{
        q,
        from,
        to,
        userId,
        estimated,
        sort_by: sortBy,
        order: sortBy ? order : undefined,
      }}
      filters={<UsageLogsFilter from={from} to={to} userId={userId} estimated={estimated} />}
      error={loadError}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        sort={{ sortBy, order }}
        searchParams={{ q, from, to, userId, estimated }}
        empty={t('noLogs')}
      />
    </ListPage>
  );
}
