import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  KpiCard,
  PageHeader,
} from '@tillgate/ui';
import { adminApi } from '@/server/admin-api';
import { ActivityIcon, BarChart3Icon, CpuIcon, DollarSignIcon, ServerIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';
import type { StatsOverview, StatsTrendRow } from '@tillgate/api-client';
import { fmtBalance, fmtInt } from '@/lib/formatters';

import { CostChart, RequestsChart } from '@/features/dashboard/admin-charts';

export const dynamic = 'force-dynamic';

/** 渠道健康聚合：healthy / degraded / down 计数（缺数据全 0） */
function countChannelHealth(stats: StatsOverview | null): {
  healthy: number;
  degraded: number;
  down: number;
} {
  const healthy = stats?.channelHealth?.find((c) => c.status === 0)?.count ?? 0;
  const degraded = stats?.channelHealth?.find((c) => c.status === 1)?.count ?? 0;
  const down =
    stats?.channelHealth?.filter((c) => c.status >= 2).reduce((sum, c) => sum + c.count, 0) ?? 0;
  return { healthy, degraded, down };
}

/** KPI 网格：今日请求/消耗/Token/渠道健康四卡（从页面提出，字段平铺） */
// eslint-disable-next-line complexity -- 四张 KPI 卡的字段逐项平铺（?? 兜底为数据声明，非控制流），拆分收益为负
function DashboardKpis({
  stats,
  t,
  healthy,
  degraded,
  down,
}: {
  stats: StatsOverview | null;
  t: Awaited<ReturnType<typeof getTranslations<'dashboard'>>>;
  healthy: number;
  degraded: number;
  down: number;
}) {
  const totalChannels = healthy + degraded + down;
  return (
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
        value={`${fmtInt(healthy)} / ${fmtInt(totalChannels)}`}
        sub={
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
              <span className="size-1.5 rounded-full bg-amber-500" />
              {t('degraded', { count: fmtInt(degraded) })}
            </span>
            <span className="inline-flex items-center gap-1 text-destructive">
              <span className="size-1.5 rounded-full bg-destructive" />
              {t('down', { count: fmtInt(down) })}
            </span>
          </span>
        }
        hint={t('realtimeProbe')}
      />
    </div>
  );
}

export default async function AdminDashboardPage() {
  const t = await getTranslations('dashboard');
  const tUi = await getTranslations('ui');
  let stats: StatsOverview | null = null;
  let trends: StatsTrendRow[] = [];
  let loadError: string | null = null;

  try {
    stats = await adminApi().get<StatsOverview>('/v1/stats/overview');
  } catch (error) {
    loadError = error instanceof ApiError ? error.message : t('loadFailed');
  }

  try {
    const res = await adminApi().get<{ rows?: StatsTrendRow[] }>('/v1/stats/trends?days=14');
    trends = res.rows ?? [];
  } catch {
    // 趋势失败不阻塞整页
  }

  const {
    healthy: healthyCount,
    degraded: degradedCount,
    down: downCount,
  } = countChannelHealth(stats);

  // 趋势序列（近 14 天，含今日；无量的日子由后端缺行表示，图表自然断点）
  const requestsSeries = trends.map((tr) => ({ date: tr.date, value: tr.requests }));
  const costSeries = trends.map((tr) => ({
    date: tr.date,
    value: Number(tr.cost ?? 0),
  }));

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <PageHeader title={t('title')} description={t('description')} icon={<BarChart3Icon />} />

      {loadError ? (
        <Card className="bg-muted/20 shadow-none ring-1 ring-border/60">
          <CardContent className="p-6 text-destructive text-sm">{loadError}</CardContent>
        </Card>
      ) : null}

      <DashboardKpis
        stats={stats}
        t={t}
        healthy={healthyCount}
        degraded={degradedCount}
        down={downCount}
      />

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
