import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  KpiCard,
  PageHeader,
} from '@tokenlens/ui';
import { adminApi } from '@/server/admin-api';
import { ActivityIcon, BarChart3Icon, CpuIcon, DollarSignIcon, ServerIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tokenlens/api-client';
import type { StatsOverview, StatsTrendRow } from '@tokenlens/api-client';
import { fmtBalance, fmtInt } from '@/lib/formatters';

import { CostChart, RequestsChart } from '@/features/dashboard/admin-charts';

export const dynamic = 'force-dynamic';

export default async function AdminDashboardPage() {
  const t = await getTranslations('dashboard');
  const tUi = await getTranslations('ui');
  let stats: StatsOverview | null = null;
  let trends: StatsTrendRow[] = [];
  let error: string | null = null;

  try {
    stats = await adminApi().get<StatsOverview>('/v1/stats/overview');
  } catch (e) {
    error = e instanceof ApiError ? e.message : t('loadFailed');
  }

  try {
    const res = await adminApi().get<{ rows?: StatsTrendRow[] }>('/v1/stats/trends?days=14');
    trends = res.rows ?? [];
  } catch {
    // 趋势失败不阻塞整页
  }

  const healthyCount = stats?.channelHealth?.find((c) => c.status === 0)?.count ?? 0;
  const degradedCount = stats?.channelHealth?.find((c) => c.status === 1)?.count ?? 0;
  const downCount =
    stats?.channelHealth?.filter((c) => c.status >= 2).reduce((sum, c) => sum + c.count, 0) ?? 0;
  const totalChannels = healthyCount + degradedCount + downCount;

  // 趋势序列（近 14 天，含今日；无量的日子由后端缺行表示，图表自然断点）
  const requestsSeries = trends.map((tr) => ({ date: tr.date, value: tr.requests }));
  const costSeries = trends.map((tr) => ({
    date: tr.date,
    value: Number(tr.cost ?? 0),
  }));

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <PageHeader title={t('title')} description={t('description')} icon={<BarChart3Icon />} />

      {error ? (
        <Card className="bg-muted/20 shadow-none ring-1 ring-border/60">
          <CardContent className="p-6 text-destructive text-sm">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-4 @lg/main:grid-cols-4">
        <KpiCard
          icon={<ActivityIcon className="size-4" />}
          label={t('todayRequests')}
          value={fmtInt(stats?.today?.requests ?? 0)}
          sub={t('todaySub', {
            success: fmtInt(stats?.today?.successCount ?? 0),
            failed: fmtInt(stats?.today?.failedCount ?? 0),
          })}
          hint={
            typeof stats?.today?.successRate === 'number'
              ? t('successRate', { rate: stats.today.successRate.toFixed(1) })
              : undefined
          }
        />
        <KpiCard
          icon={<DollarSignIcon className="size-4" />}
          label={t('todaySpend')}
          value={fmtBalance(stats?.today?.cost ?? 0)}
          sub={t('totalSpend', { amount: fmtBalance(stats?.total?.cost ?? 0) })}
          hint={t('totalRequests', { count: fmtInt(stats?.total?.requests ?? 0) })}
        />
        <KpiCard
          icon={<CpuIcon className="size-4" />}
          label={t('todayInputTokens')}
          value={fmtInt(stats?.today?.inputTokens ?? 0)}
          sub={t('todayOutputTokens', { count: fmtInt(stats?.today?.outputTokens ?? 0) })}
          hint={t('billedByTokens')}
        />
        <KpiCard
          icon={<ServerIcon className="size-4" />}
          label={t('channelHealth')}
          value={`${fmtInt(healthyCount)} / ${fmtInt(totalChannels)}`}
          sub={
            <span className="inline-flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                <span className="size-1.5 rounded-full bg-amber-500" />
                {t('degraded', { count: fmtInt(degradedCount) })}
              </span>
              <span className="inline-flex items-center gap-1 text-destructive">
                <span className="size-1.5 rounded-full bg-destructive" />
                {t('down', { count: fmtInt(downCount) })}
              </span>
            </span>
          }
          hint={t('realtimeProbe')}
        />
      </div>

      {/* 大图表区：请求趋势 + 消耗趋势 */}
      <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
        <Card className="bg-muted/20 shadow-none ring-1 ring-border/60">
          <CardHeader>
            <CardTitle className="text-base">{t('requestsTrend')}</CardTitle>
            <CardDescription>{t('requestsTrendDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {requestsSeries.length === 0 ? (
              <EmptyChart label={tUi('empty')} />
            ) : (
              <RequestsChart data={requestsSeries} />
            )}
          </CardContent>
        </Card>

        <Card className="bg-muted/20 shadow-none ring-1 ring-border/60">
          <CardHeader>
            <CardTitle className="text-base">{t('spend')}</CardTitle>
            <CardDescription>{t('spendTrendDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {costSeries.length === 0 ? (
              <EmptyChart label={tUi('empty')} />
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

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-62.5 items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
