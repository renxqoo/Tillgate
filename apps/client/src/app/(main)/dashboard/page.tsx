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
} from '@tokenlens/ui';
import type {
  UsageByModelItem,
  UsageByModelPage,
  UsageDayRow,
  UsageRate,
  UsageSummaryPage,
} from '@tokenlens/api-client';

import { CostChart } from '@/features/dashboard/cost-chart';
import {
  TREND_WINDOW_DAYS,
  fillDailyCostSeries,
  trendWindowFrom,
} from '@/features/dashboard/cost-trend';
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
  dailyCost: Array<{ date: string; value: number }>;
  todayCost: number;
  byModel: ReadonlyArray<UsageByModelItem>;
}

export default async function DashboardPage() {
  const api = createClientApi();
  const me = await requireMe(api);
  const t = await getTranslations('dashboard');
  const locale = await getLocale();

  let data: DashboardData = {
    balance: me.accounts.find((account) => account.currency === 'CNY')?.balance ?? '0',
    rateCardName: me.rateCardName,
    rpmLimit: me.rpmLimit,
    tpmLimit: me.tpmLimit,
    rpm: 0,
    tpm: 0,
    activeKeys: 0,
    totalKeys: 0,
    dailyCost: [],
    todayCost: 0,
    byModel: [],
  };

  // Key 总数（信封 total——B4 修复：v1 首页 100 条内计数在 Key 超量后低估）
  try {
    const keysData = await api.list<{ status: number }>('/v1/keys', { pageSize: 100 });
    data.totalKeys = keysData.total;
    data.activeKeys = keysData.rows.filter((k) => k.status === 0).length;
  } catch {
    // ignore
  }

  // 近 14 天按日费用（/v1/usage/summary 按日聚合，日界 = 后端 CLIENT_USAGE_TZ；
  // 起点取起始日 00:00、序列按日补零——B21 修复：首日不再半桶、无消费日不再从图上消失）
  try {
    const from = trendWindowFrom(TREND_WINDOW_DAYS, DISPLAY_TZ);
    const summary = await api.get<UsageSummaryPage>(`/v1/usage/summary?from=${from.toISOString()}`);
    const dayRows: UsageDayRow[] = summary.list ?? [];
    data.dailyCost =
      dayRows.length > 0 ? fillDailyCostSeries(dayRows, TREND_WINDOW_DAYS, DISPLAY_TZ) : [];
    // 今日费用：DISPLAY_TZ 日界推导（v1 +8h 硬编码近似——B8 修复）
    data.todayCost = todayCost(dayRows, DISPLAY_TZ);
  } catch {
    // 用量不可达时图表留空
  }

  // 按模型聚合（模型分布卡片；信封单形态 {rows}——B5 修复）
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
          <CostChart data={data.dailyCost} />
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
