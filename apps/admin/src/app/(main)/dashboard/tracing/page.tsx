import Link from 'next/link';
import { Activity } from 'lucide-react';
import { fmtDateTime } from '@ai-gateway/api-client';
import { fetchAdminList } from '@ai-gateway/api-client/list';
import { Badge } from '@ai-gateway/ui/components/ui/badge';
import { Card, CardDescription, CardHeader } from '@ai-gateway/ui/components/ui/card';
import { DataTable } from '@ai-gateway/ui/components/data-table';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { firstParam, parseListSearchParams } from "@ai-gateway/ui/lib/list-query";
import { TraceDetailDialog } from './_components/trace-detail-dialog';

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
  const sp = await searchParams;
  const { page } = parseListSearchParams(sp);
  const params = {
    requestId: firstParam(sp.requestId),
    errorsOnly: firstParam(sp.errorsOnly),
  };
  const { rows: items, total, error } = await fetchAdminList<TraceSummary>(
    '/api/admin/tracing/recent',
    {
      page,
      pageSize: PAGE_SIZE,
      extra: {
        requestId: params.requestId,
        errorsOnly: params.errorsOnly === 'true' ? 'true' : undefined,
      },
    },
  );

  return (
    <div className="flex flex-col gap-4">
      {params.requestId ? (
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>
              按 request_id 过滤：
              <code className="mx-1 rounded bg-muted px-1">{params.requestId}</code>
              <Link href="/dashboard/tracing" className="ml-2 underline">
                清除
              </Link>
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <ListPage
        title="链路追踪"
        icon={<Activity className="size-5 text-muted-foreground" />}
        description={
          <span>
            内置 trace 接收端数据（trace_spans，按日分区滚动保留）；与计费系统同库，支持
            request_id 关联。
            <Link href="/dashboard/tracing/topology" className="ml-2 underline">
              渠道健康拓扑 →
            </Link>
          </span>
        }
        total={total}
        filters={
          <Link
            href={`/dashboard/tracing?${params.errorsOnly === 'true' ? '' : 'errorsOnly=true'}`}
            className="text-sm underline"
          >
            {params.errorsOnly === 'true' ? '显示全部' : '只看含错误的'}
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
              render: (t: TraceSummary) => (
                <span className="font-mono text-xs">
                  <TraceDetailDialog traceId={t.traceId} rootName={t.rootName} />
                </span>
              ),
            },
            {
              key: 'rootName',
              header: '入口',
              render: (t: TraceSummary) => (
                <span className="block max-w-64 truncate">{t.rootName}</span>
              ),
            },
            {
              key: 'durationMs',
              header: '耗时',
              align: 'right',
              render: (t: TraceSummary) => (
                <span className="text-right tabular-nums">{t.durationMs} ms</span>
              ),
            },
            {
              key: 'spanCount',
              header: 'span',
              align: 'right',
              render: (t: TraceSummary) => <span className="text-right tabular-nums">{t.spanCount}</span>,
            },
            {
              key: 'services',
              header: '服务',
              render: (t: TraceSummary) => (
                <div className="flex flex-wrap gap-1">
                  {t.services.map((svc) => (
                    <Badge key={svc} variant="outline">
                      {svc}
                    </Badge>
                  ))}
                  {t.hasError ? <Badge variant="destructive">ERROR</Badge> : null}
                </div>
              ),
            },
            {
              key: 'requestId',
              header: 'request_id',
              render: (t: TraceSummary) => (
                <span className="font-mono text-xs">
                  {t.requestId ? <TraceDetailDialog requestId={t.requestId} /> : '—'}
                </span>
              ),
            },
            {
              key: 'startTimeMs',
              header: '开始时间',
              render: (t: TraceSummary) => (
                <span className="text-xs">{fmtDateTime(new Date(t.startTimeMs).toISOString())}</span>
              ),
            },
          ]}
          rows={items}
          rowKey={(t: TraceSummary) => t.traceId}
          empty="暂无数据。确认 trace-receiver 已启动且各服务 OTEL_TRACES_MODE=otlp 指向它。"
        />
      </ListPage>

      {/* 计费复核「查链路」深链落地：自动打开该请求的链路弹窗（替代原列表下方内联模块） */}
      {params.requestId && !error ? (
        <TraceDetailDialog requestId={params.requestId} defaultOpen hideTrigger />
      ) : null}
    </div>
  );
}
