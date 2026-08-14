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
import { TraceWaterfall } from './_components/trace-waterfall';

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

interface TraceDetail {
  spans: Array<{
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    name: string;
    service: string;
    startTime: string;
    endTime: string;
    durationMs: number;
    statusCode: number;
    statusMessage: string | null;
    requestId: string | null;
    channel: string | null;
    model: string | null;
    attributes: Record<string, unknown>;
  }>;
  services: string[];
  startMs: number;
  durationMs: number;
}

export default async function TracingPage({
  searchParams,
}: {
  searchParams: Promise<{ requestId?: string; errorsOnly?: string; traceId?: string }>;
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

  // traceId 直达（计费复核「查链路」入口也可带 requestId 过滤）
  let detail: TraceDetail | null = null;
  const wantedTrace = params.traceId ?? items[0]?.traceId;
  if (wantedTrace && !error) {
    try {
      const response = await adminFetch<TraceDetail>(`/api/admin/tracing/traces/${wantedTrace}`);
      if (response.spans.length > 0) detail = response;
    } catch {
      detail = null;
    }
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
                      <Link
                        href={`/dashboard/tracing?traceId=${t.traceId}`}
                        className="underline"
                      >
                        {t.traceId.slice(0, 12)}…
                      </Link>
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
                        <Link
                          href={`/dashboard/tracing?requestId=${t.requestId}`}
                          className="underline"
                        >
                          {t.requestId.slice(0, 14)}…
                        </Link>
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

      {detail ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>
              瀑布图 · <code className="font-mono text-sm">{detail.spans[0]!.traceId}</code>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TraceWaterfall spans={detail.spans} startMs={detail.startMs} totalMs={detail.durationMs} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
