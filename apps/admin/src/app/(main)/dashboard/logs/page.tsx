import { requirePermission } from '@/server/get-admin';
import type { DataTableColumn } from '@/components/data-table';

import { DataTable } from '@/components/data-table';
import { adminApi } from '@/server/admin-api';
import { ScrollTextIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';
import type { LogRow, Paginated } from '@tillgate/api-client';
import { fmtDateTime, msToHuman } from '@/lib/formatters';
import { ListPage } from '@/components/list-page';
import { firstParam, parseListSearchParams } from '@/lib/list-query';

import { LogsFilter } from '@/features/tracing/logs-filter';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function statusCodeTone(code: number): string {
  if (code >= 200 && code < 300) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (code >= 400 && code < 500) return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  if (code >= 500) return 'bg-destructive/15 text-destructive';
  return 'bg-muted text-muted-foreground';
}

/** 日志表列定义（cell 渲染器随列声明平铺；t/tc 经参数传入） */
function buildLogColumns(
  t: Awaited<ReturnType<typeof getTranslations<'logs'>>>,
  tc: Awaited<ReturnType<typeof getTranslations<'common'>>>,
): DataTableColumn<LogRow>[] {
  return [
    {
      key: 'requestId',
      header: 'Request ID',
      render: (l) => (
        <code className="text-xs text-muted-foreground">{l.requestId.slice(0, 8)}</code>
      ),
    },
    {
      key: 'userName',
      header: tc('user'),
      render: (l) => (
        <span className="text-xs">{l.userName ?? (l.userId ? `#${l.userId}` : '—')}</span>
      ),
    },
    {
      key: 'method',
      header: t('method'),
      render: (l) => <span className="text-xs text-muted-foreground">{l.method}</span>,
    },
    {
      key: 'path',
      header: t('path'),
      render: (l) => <code className="text-xs">{l.path}</code>,
    },
    {
      key: 'sourceIp',
      header: t('sourceIp'),
      render: (l) => (
        <span className="text-xs tabular-nums text-muted-foreground">{l.sourceIp ?? '—'}</span>
      ),
    },
    {
      key: 'model',
      header: t('model'),
      render: (l) => (
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          {l.requestSummary?.model ?? '—'}
        </code>
      ),
    },
    {
      key: 'channels',
      header: t('channels'),
      render: (l) => {
        if (l.channels == null || l.channels.length === 0) {
          return <span className="text-xs text-muted-foreground">—</span>;
        }
        // 末位 = 最终服务/最后评估的渠道；其余为换渠轨迹（含被门拒绝的渠道）
        const [last, ...rest] = l.channels.toReversed();
        return (
          <span className="flex flex-wrap items-center gap-1">
            {rest.map((name) => (
              <code
                key={name}
                className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                {name}
              </code>
            ))}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{last}</code>
          </span>
        );
      },
    },
    {
      key: 'statusCode',
      header: t('statusCode'),
      sortable: true,
      headerClassName: 'w-20',
      render: (l) => (
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${statusCodeTone(
            l.statusCode,
          )}`}
        >
          {l.statusCode}
        </span>
      ),
    },
    {
      key: 'durationMs',
      header: t('duration'),
      sortable: true,
      align: 'right',
      render: (l) => (
        <span className="text-right text-xs tabular-nums text-muted-foreground">
          {msToHuman(l.durationMs)}
        </span>
      ),
    },
    {
      key: 'attempts',
      header: t('retries'),
      align: 'right',
      render: (l) => (
        <span className="text-right text-xs tabular-nums text-muted-foreground">
          {l.attempts > 1 ? t('retryTimes', { count: l.attempts }) : '—'}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: tc('time'),
      sortable: true,
      headerClassName: 'w-44',
      render: (l) => (
        <span className="text-xs text-muted-foreground">{fmtDateTime(l.createdAt)}</span>
      ),
    },
    {
      key: 'errorCode',
      header: t('errorCode'),
      render: (l) => (
        <span className="max-w-xs truncate text-xs text-destructive">{l.errorCode ?? '—'}</span>
      ),
    },
  ];
}

export default async function LogsPage({ searchParams }: PageProps) {
  await requirePermission('ops:read');
  const sp = await searchParams;
  const t = await getTranslations('logs');
  const tc = await getTranslations('common');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const from = firstParam(sp.from) ?? '';
  const to = firstParam(sp.to) ?? '';
  const userId = firstParam(sp.userId) ?? '';
  const statusCode = firstParam(sp.statusCode) ?? '';
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(PAGE_SIZE),
    sort_by: sortBy ?? 'createdAt',
    order,
  });
  // 非空筛选统一并入 query（q/from/to/userId/statusCode）
  for (const [key, value] of Object.entries({ q, from, to, userId, statusCode })) {
    if (value) query.set(key, value);
  }

  let rows: LogRow[] = [];
  let total = 0;
  let loadError: string | null = null;
  try {
    const data = await adminApi().get<Paginated<LogRow>>(`/v1/logs?${query.toString()}`);
    rows = data.rows ?? [];
    total = data.total ?? 0;
  } catch (error) {
    loadError = error instanceof ApiError ? error.message : tc('loadFailed');
  }

  const columns = buildLogColumns(t, tc);

  return (
    <ListPage
      title={t('title')}
      icon={<ScrollTextIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q, from, to, userId, sort_by: sortBy, order: sortBy ? order : undefined }}
      filters={<LogsFilter from={from} to={to} userId={userId} statusCode={statusCode} />}
      error={loadError}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(l) => l.id}
        sort={{ sortBy, order }}
        searchParams={{ q, from, to, userId }}
        empty={t('noLogs')}
      />
    </ListPage>
  );
}
