import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@tillgate/ui';
import { adminApi } from '@/server/admin-api';
import { BarChart3Icon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tillgate/api-client';
import type { StatsOverview, StatsTrendRow } from '@tillgate/api-client';

import { CostChart, RequestsChart } from '@/features/dashboard/admin-charts';

import { DashboardKpis } from './dashboard-kpis';
import { EmptyChart } from './empty-chart';

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
