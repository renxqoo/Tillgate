import {
  ActivityIcon,
  BarChart3Icon,
  CpuIcon,
  DollarSignIcon,
  ServerIcon,
} from "lucide-react";

import {
  ApiError,
  adminFetch,
  fmtBalance,
  fmtInt,
  type StatsOverview,
  type StatsUsageItem,
} from "@ai-gateway/api-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ai-gateway/ui/components/ui/card";

import { CostChart, RequestsChart } from "./_components/admin-charts";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  let stats: StatsOverview | null = null;
  let usage: StatsUsageItem[] = [];
  let error: string | null = null;

  try {
    stats = await adminFetch<StatsOverview>("/api/admin/stats/overview");
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载统计失败";
  }

  try {
    const res = await adminFetch<{ rows?: StatsUsageItem[]; list?: StatsUsageItem[] }>("/api/admin/stats/usage");
    usage = res.rows ?? [];
  } catch {
    // usage 失败不阻塞整页
  }

  const healthyCount =
    stats?.channelHealth?.find((c) => c.status === 0)?.count ?? 0;
  const degradedCount =
    stats?.channelHealth?.find((c) => c.status === 1)?.count ?? 0;
  const downCount =
    stats?.channelHealth
      ?.filter((c) => c.status >= 2)
      .reduce((sum, c) => sum + c.count, 0) ?? 0;
  const totalChannels = healthyCount + degradedCount + downCount;

  // 按维度（key，通常是日期）转成图表数据
  const requestsSeries = usage.map((u) => ({ date: u.key, value: u.requests }));
  const costSeries = usage.map((u) => ({
    date: u.key,
    value: Number(u.cost ?? 0),
  }));

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BarChart3Icon className="size-5 text-muted-foreground" />
          仪表盘
        </h1>
        <p className="text-sm text-muted-foreground">整体运营概况</p>
      </div>

      {error ? (
        <Card>
          <CardContent className="p-6 text-destructive text-sm">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-4 @lg/main:grid-cols-4">
        <KpiCard
          icon={<ActivityIcon className="size-4" />}
          title="今日请求"
          value={fmtInt(stats?.today?.requests ?? 0)}
          sub={`成功 ${fmtInt(stats?.today?.successCount ?? 0)} · 失败 ${fmtInt(stats?.today?.failedCount ?? 0)}`}
          hint={
            typeof stats?.today?.successRate === "number"
              ? `成功率 ${(stats.today.successRate * 100).toFixed(1)}%`
              : undefined
          }
        />
        <KpiCard
          icon={<DollarSignIcon className="size-4" />}
          title="今日消耗（元）"
          value={fmtBalance(stats?.today?.cost ?? 0)}
          sub={`累计消耗 ${fmtBalance(stats?.total?.cost ?? 0)}`}
          hint={`累计请求 ${fmtInt(stats?.total?.requests ?? 0)}`}
        />
        <KpiCard
          icon={<CpuIcon className="size-4" />}
          title="今日输入 tokens"
          value={fmtInt(stats?.today?.inputTokens ?? 0)}
          sub={`输出 ${fmtInt(stats?.today?.outputTokens ?? 0)}`}
          hint="按令牌计费"
        />
        <KpiCard
          icon={<ServerIcon className="size-4" />}
          title="渠道健康"
          value={`${fmtInt(healthyCount)} / ${fmtInt(totalChannels)}`}
          sub={
            <span className="inline-flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                <span className="size-1.5 rounded-full bg-amber-500" />
                降级 {fmtInt(degradedCount)}
              </span>
              <span className="inline-flex items-center gap-1 text-destructive">
                <span className="size-1.5 rounded-full bg-destructive" />
                异常 {fmtInt(downCount)}
              </span>
            </span>
          }
          hint="实时探测"
        />
      </div>

      {/* 大图表区：请求趋势 + 消耗趋势 */}
      <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">请求量趋势</CardTitle>
            <CardDescription>按维度（通常为日期）聚合的请求数</CardDescription>
          </CardHeader>
          <CardContent>
            {requestsSeries.length === 0 ? (
              <EmptyChart />
            ) : (
              <RequestsChart data={requestsSeries} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">消耗（元）</CardTitle>
            <CardDescription>按维度聚合的消耗金额</CardDescription>
          </CardHeader>
          <CardContent>
            {costSeries.length === 0 ? (
              <EmptyChart />
            ) : (
              <CostChart data={costSeries} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* 渠道健康详情见 /dashboard/channels */}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-62.5 items-center justify-center text-sm text-muted-foreground">
      暂无数据
    </div>
  );
}

function KpiCard({
  icon,
  title,
  value,
  sub,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  sub?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <CardDescription className="flex items-center gap-2">
          <span className="inline-flex size-7 items-center justify-center rounded-md bg-muted text-foreground">
            {icon}
          </span>
          {title}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums tracking-tight">
          {value}
        </CardTitle>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
    </Card>
  );
}
