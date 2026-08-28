import { KpiCard } from '@tillgate/ui';
import { ActivityIcon, CpuIcon, DollarSignIcon, ServerIcon } from 'lucide-react';
import type { getTranslations } from 'next-intl/server';
import type { StatsOverview } from '@tillgate/api-client';
import { fmtBalance, fmtInt } from '@/lib/formatters';

/** KPI 网格：今日请求/消耗/Token/渠道健康四卡（从页面提出，字段平铺） */
// eslint-disable-next-line complexity -- 四张 KPI 卡的字段逐项平铺（?? 兜底为数据声明，非控制流），拆分收益为负
export function DashboardKpis({
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
