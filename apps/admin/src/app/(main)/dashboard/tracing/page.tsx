import Link from 'next/link';
import { Activity } from 'lucide-react';
import { ApiError, adminFetch, fmtDateTime } from '@ai-gateway/api-client';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ai-gateway/ui/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';
import { Badge } from '@ai-gateway/ui/components/ui/badge';
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

export default async function TracingPage({
  searchParams,
}: {
  searchParams: Promise<{
    requestId?: string;
    errorsOnly?: string;
  }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams({ limit: '50' });
  if (params.requestId) query.set('requestId', params.requestId);
  if (params.errorsOnly === 'true') query.set('errorsOnly', 'true');

  let items: TraceSummary[] = [];
  let error: string | null = null;
  try {
    const response = await adminFetch<{ items: TraceSummary[] }>(
      `/api/admin/tracing/recent?${query.toString()}`,
    );
    items = response.items;
  } catch (caught) {
    error = caught instanceof ApiError ? caught.message : '加载失败';
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Activity className="size-5" />
          链路追踪
        </h1>
        <p className="text-sm text-muted-foreground">
          内置 trace 接收端数据（trace_spans，按日分区滚动保留）；与计费系统同库，支持
          request_id 关联。
          <Link href="/dashboard/tracing/topology" className="ml-2 underline">
            渠道健康拓扑 →
          </Link>
        </p>
      </div>

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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>最近 traces（24h）</CardTitle>
          <CardDescription>
            <Link
              href={`/dashboard/tracing?${params.errorsOnly === 'true' ? '' : 'errorsOnly=true'}`}
              className="underline"
            >
              {params.errorsOnly === 'true' ? '显示全部' : '只看含错误的'}
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              暂无数据。确认 trace-receiver 已启动且各服务 OTEL_TRACES_MODE=otlp 指向它。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>trace</TableHead>
                  <TableHead>入口</TableHead>
                  <TableHead className="text-right">耗时</TableHead>
                  <TableHead className="text-right">span</TableHead>
                  <TableHead>服务</TableHead>
                  <TableHead>request_id</TableHead>
                  <TableHead>开始时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((t) => (
                  <TableRow key={t.traceId}>
                    <TableCell className="font-mono text-xs">
                      <TraceDetailDialog traceId={t.traceId} rootName={t.rootName} />
                    </TableCell>
                    <TableCell className="max-w-64 truncate">{t.rootName}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.durationMs} ms</TableCell>
                    <TableCell className="text-right tabular-nums">{t.spanCount}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {t.services.map((s) => (
                          <Badge key={s} variant="outline">
                            {s}
                          </Badge>
                        ))}
                        {t.hasError ? <Badge variant="destructive">ERROR</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {t.requestId ? (
                        <TraceDetailDialog requestId={t.requestId} />
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{fmtDateTime(new Date(t.startTimeMs).toISOString())}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 计费复核「查链路」深链落地：自动打开该请求的链路弹窗（替代原列表下方内联模块） */}
      {params.requestId && !error ? (
        <TraceDetailDialog requestId={params.requestId} defaultOpen hideTrigger />
      ) : null}
    </div>
  );
}
