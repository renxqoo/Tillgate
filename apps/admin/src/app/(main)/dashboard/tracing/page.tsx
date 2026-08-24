import { requirePermission } from '@/server/get-admin';
import { Badge, Card, CardDescription, CardHeader } from '@tillgate/ui';
import { DataTable } from '@/components/data-table';
import Link from 'next/link';
import { Activity } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fmtDateTime } from '@/lib/formatters';
import { fetchAdminList } from '@/server/admin-list';
import { ListPage } from '@/components/list-page';
import { firstParam, parseListSearchParams } from '@/lib/list-query';
import { TraceDetailDialog } from '@/features/tracing/trace-detail-dialog';

export const dynamic = 'force-dynamic';

interface TraceSummary {
  traceId: string;
  rootName: string;
  startTimeMs: number;
  durationMs: number;
  spanCount: number;
  hasError: boolean;
  services: string[];
  requestId: string | null;
}

const PAGE_SIZE = 20;

export default async function TracingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('ops:read');
  const sp = await searchParams;
  const t = await getTranslations('tracing');
  const tc = await getTranslations('common');
  const { page } = parseListSearchParams(sp);
  const params = {
    requestId: firstParam(sp.requestId),
    errorsOnly: firstParam(sp.errorsOnly),
  };
  const {
    rows: items,
    total,
    error,
  } = await fetchAdminList<TraceSummary>('/v1/tracing/recent', {
    page,
    pageSize: PAGE_SIZE,
    extra: {
      requestId: params.requestId,
      errorsOnly: params.errorsOnly === 'true' ? 'true' : undefined,
    },
  });

  return (
    <div className="flex flex-col gap-4">
      {params.requestId ? (
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>
              {t('filterByRequestId')}
              <code className="mx-1 rounded bg-muted px-1">{params.requestId}</code>
              <Link href="/dashboard/tracing" className="ml-2 underline">
                {tc('clear')}
              </Link>
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <ListPage
        title={t('title')}
        icon={<Activity className="size-5 text-muted-foreground" />}
        description={
          <span>
            {t('description')}
            <Link href="/dashboard/tracing/topology" className="ml-2 underline">
              {t('topologyLink')}
            </Link>
          </span>
        }
        total={total}
        filters={
          <Link
            href={`/dashboard/tracing?${params.errorsOnly === 'true' ? '' : 'errorsOnly=true'}`}
            className="text-sm underline"
          >
            {params.errorsOnly === 'true' ? t('showAll') : t('errorsOnly')}
          </Link>
        }
        searchParams={{
          requestId: params.requestId,
          errorsOnly: params.errorsOnly === 'true' ? 'true' : undefined,
        }}
        error={error}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <DataTable
          columns={[
            {
              key: 'traceId',
              header: 'trace',
              render: (tr: TraceSummary) => (
                <span className="font-mono text-xs">
                  <TraceDetailDialog traceId={tr.traceId} rootName={tr.rootName} />
                </span>
              ),
            },
            {
              key: 'rootName',
              header: t('entry'),
              render: (tr: TraceSummary) => (
                <span className="block max-w-64 truncate">{tr.rootName}</span>
              ),
            },
            {
              key: 'durationMs',
              header: t('duration'),
              align: 'right',
              render: (tr: TraceSummary) => (
                <span className="text-right tabular-nums">{tr.durationMs} ms</span>
              ),
            },
            {
              key: 'spanCount',
              header: 'span',
              align: 'right',
              render: (tr: TraceSummary) => (
                <span className="text-right tabular-nums">{tr.spanCount}</span>
              ),
            },
            {
              key: 'services',
              header: t('services'),
              render: (tr: TraceSummary) => (
                <div className="flex flex-wrap gap-1">
                  {tr.services.map((svc) => (
                    <Badge key={svc} variant="outline">
                      {svc}
                    </Badge>
                  ))}
                  {tr.hasError ? <Badge variant="destructive">ERROR</Badge> : null}
                </div>
              ),
            },
            {
              key: 'requestId',
              header: 'request_id',
              render: (tr: TraceSummary) => (
                <span className="font-mono text-xs">
                  {tr.requestId ? <TraceDetailDialog requestId={tr.requestId} /> : '—'}
                </span>
              ),
            },
            {
              key: 'startTimeMs',
              header: t('startTime'),
              render: (tr: TraceSummary) => (
                <span className="text-xs">
                  {fmtDateTime(new Date(tr.startTimeMs).toISOString())}
                </span>
              ),
            },
          ]}
          rows={items}
          rowKey={(tr: TraceSummary) => tr.traceId}
          empty={t('emptyHint')}
        />
      </ListPage>

      {/* 计费复核「查链路」深链落地：自动打开该请求的链路弹窗（替代原列表下方内联模块） */}
      {params.requestId && !error ? (
        <TraceDetailDialog requestId={params.requestId} defaultOpen hideTrigger />
      ) : null}
    </div>
  );
}
