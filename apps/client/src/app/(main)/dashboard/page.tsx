import { CoinsIcon, GaugeIcon, KeyRoundIcon, WalletIcon } from 'lucide-react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@tillgate/ui';
import type {
  UsageByModelItem,
  UsageByModelPage,
  UsageRate,
  UsageSummaryPage,
  UsageTrendPage,
  UsageTrendRow,
} from '@tillgate/api-client';

import { TrendChart } from '@/features/dashboard/trend-chart';
import { TREND_WINDOW_DAYS, trendWindowFrom } from '@/features/dashboard/trend-series';
import { KpiCard } from '@/features/dashboard/kpi-card';
import { todayCost } from '@/features/dashboard/kpi';
import { ModelUsageChart } from '@/features/dashboard/model-usage-chart';
import { formatInt, formatMoney } from '@/features/shared/format';
import { DISPLAY_TZ } from '@/config/display';
import { createClientApi } from '@/server/api';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

interface DashboardData {
  balance: string;
  rateCardName: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 近 60 秒实际请求数（RPM） */
  rpm: number;
  /** 近 60 秒实际 token 数（TPM） */
  tpm: number;
  activeKeys: number;
  totalKeys: number;
  /** day 粒度趋势行（服务端预取；序列补零在组件内纯函数完成） */
  trendDayRows: ReadonlyArray<UsageTrendRow>;
  todayCost: number;
  byModel: ReadonlyArray<UsageByModelItem>;
}

/** 按日汇总（今日费用 KPI 用；与 trend 独立——summary 不带模型维度） */
async function fetchUsageSummary(
  api: ReturnType<typeof createClientApi>,
  from: Date,
): Promise<UsageSummaryPage['list']> {
  const summary = await api.get<UsageSummaryPage>(`/v1/usage/summary?from=${from.toISOString()}`);
  return summary.list ?? [];
}

export default async function DashboardPage() {
  const api = createClientApi();
  const me = await requireMe(api);
  const t = await getTranslations('dashboard');
  const locale = await getLocale();
  const now = new Date();

  const data: DashboardData = {
    balance: me.accounts.find((account) => account.currency === 'CNY')?.balance ?? '0',
    rateCardName: me.rateCardName,
    rpmLimit: me.rpmLimit,
    tpmLimit: me.tpmLimit,
    rpm: 0,
    tpm: 0,
    activeKeys: 0,
    totalKeys: 0,
    trendDayRows: [],
    todayCost: 0,
    byModel: [],
  };

  // Key 总数（信封 total——按单页 100 条计数会在 Key 超量后低估）
  try {
    const keysData = await api.list<{ status: number }>('/v1/keys', { pageSize: 100 });
    data.totalKeys = keysData.total;
    data.activeKeys = keysData.rows.filter((k) => k.status === 0).length;
  } catch {
    // ignore
  }

  // 近 14 天趋势（/v1/usage/trend 按日 × 模型聚合，日界 = 后端 CLIENT_USAGE_TZ；
  // 序列按日补零在组件内完成——首日不再半桶、无消费日不再从图上消失）
  try {
    const from = trendWindowFrom(TREND_WINDOW_DAYS, DISPLAY_TZ, now);
    const [trend, summaryRows] = await Promise.all([
      api.get<UsageTrendPage>(`/v1/usage/trend?granularity=day&from=${from.toISOString()}`),
      fetchUsageSummary(api, from),
    ]);
    data.trendDayRows = trend.list ?? [];
    // 今日费用：DISPLAY_TZ 日界推导（显式时区，不用 +8h 硬编码近似）
    data.todayCost = todayCost(summaryRows, DISPLAY_TZ, now);
  } catch {
    // 用量不可达时图表留空
  }

  // 按模型聚合（模型分布卡片；信封单形态 {rows}）
  try {
    const byModel = await api.get<UsageByModelPage>('/v1/usage/by-model');
    data.byModel = byModel.rows ?? [];
  } catch {
    // ignore
  }

  // 实时速率（近 60 秒 RPM / TPM）
  try {
    const rate = await api.get<UsageRate>('/v1/usage/rate');
    data.rpm = rate.rpm;
    data.tpm = rate.tpm;
  } catch {
    // 速率不可达时保持 0
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <PageHeader
        title={t('welcome', { name: me.displayName || me.subject })}
        description={t('overview')}
        actions={
          <>
            <Button variant="outline" size="sm" render={<Link href="/dashboard/redeem" />}>
              {t('redeemCode')}
            </Button>
            <Button size="sm" render={<Link href="/dashboard/keys" />}>
              {t('createKey')}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 @3xl/main:grid-cols-4">
        <KpiCard
          icon={<WalletIcon className="size-4" />}
          title={t('kpiBalance')}
          value={formatMoney(data.balance, locale)}
          hint={t('kpiBalanceHint')}
        />
        <KpiCard
          icon={<CoinsIcon className="size-4" />}
          title={t('kpiTodayCost')}
          value={formatMoney(data.todayCost, locale)}
          hint={t('kpiTodayCostHint')}
        />
        <KpiCard
          icon={<KeyRoundIcon className="size-4" />}
          title={t('kpiKeys')}
          value={formatInt(data.totalKeys)}
          sub={t('kpiActiveKeys', { count: formatInt(data.activeKeys) })}
          hint={t('kpiKeysHint')}
        />
        <KpiCard
          icon={<GaugeIcon className="size-4" />}
          title={t('kpiRate')}
          value={formatInt(data.rpm)}
          sub={t('kpiTpm', { count: formatInt(data.tpm) })}
          hint={t('kpiRateHint', {
            rpm: data.rpmLimit == null ? '∞' : formatInt(data.rpmLimit),
            tpm: data.tpmLimit == null ? '∞' : formatInt(data.tpmLimit),
          })}
        />
      </div>

      <Card className="@container/card bg-muted/20 shadow-none ring-1 ring-border/60">
        <CardHeader>
          <CardTitle className="text-base">{t('costTrendTitle')}</CardTitle>
          <CardDescription>{t('costTrendDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* now 服务端取一次传入：SSR/水合同一时钟，消除午夜/钟差边界的水合不一致 */}
          <TrendChart dayRows={data.trendDayRows} timeZone={DISPLAY_TZ} now={now} />
        </CardContent>
      </Card>

      <Card className="bg-muted/20 shadow-none ring-1 ring-border/60">
        <CardHeader>
          <CardTitle className="text-base">{t('modelUsageTitle')}</CardTitle>
          <CardDescription>{t('modelUsageDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ModelUsageChart data={data.byModel} />
        </CardContent>
      </Card>
    </div>
  );
}
