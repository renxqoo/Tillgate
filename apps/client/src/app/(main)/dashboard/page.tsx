import { CoinsIcon, GaugeIcon, KeyRoundIcon, WalletIcon } from 'lucide-react';

import { Button } from '@ai-gateway/ui/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ai-gateway/ui/components/ui/card';
import {
  apiFetch,
  fmtBalance,
  fmtInt,
  type Paginated,
  type UsageByModelItem,
  type UsageDayRow,
} from '@ai-gateway/api-client';
import { getTranslations } from 'next-intl/server';

import Link from 'next/link';

import { CostChart } from './_components/cost-chart';
import { ModelUsageChart } from './_components/model-usage-chart';
import { requireMe } from '@/lib/server/get-user';

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
  const me = await requireMe();
  const t = await getTranslations('dashboard');

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

  // 获取 Key 列表（统计活跃 / 总数）
  try {
    const keysData = await apiFetch<Paginated<{ status: number }>>('/v1/keys?page=1&limit=100');
    data.totalKeys = keysData.total;
    const keyRows = keysData.rows ?? [];
    data.activeKeys = keyRows.filter((k) => k.status === 0).length;
  } catch {
    // ignore
  }

  // 近 14 天按日费用（/v1/usage/summary 按日聚合，日界北京时间）
  try {
    const from = new Date(Date.now() - 13 * 86_400_000);
    const summary = await apiFetch<{ list?: UsageDayRow[] }>(
      `/v1/usage/summary?from=${from.toISOString()}`,
    );
    const dayRows = summary.list ?? [];
    data.dailyCost = dayRows.map((row) => ({ date: row.date, value: Number(row.cost) || 0 }));
    // 今日（北京时间，与后端日界一致）那一行的费用
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    data.todayCost = Number(dayRows.find((row) => row.date === today)?.cost ?? 0);
  } catch {
    // 用量不可达时图表留空
  }

  // 按模型聚合（模型分布卡片）
  try {
    const byModel = await apiFetch<{ rows?: UsageByModelItem[]; list?: UsageByModelItem[] }>(
      '/v1/usage/by-model',
    );
    data.byModel = byModel.rows ?? [];
  } catch {
    // ignore
  }

  // 获取实时速率（近 60 秒 RPM / TPM）
  try {
    const rate = await apiFetch<{ rpm: number; tpm: number }>('/v1/usage/rate');
    data.rpm = rate.rpm;
    data.tpm = rate.tpm;
  } catch {
    // 速率不可达时保持 0
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('welcome', { name: me.displayName || me.subject })}
          </h1>
          <p className="text-sm text-muted-foreground">{t('overview')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/redeem">{t('redeemCode')}</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/dashboard/keys">{t('createKey')}</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 @3xl/main:grid-cols-4">
        <KpiCard
          icon={<WalletIcon className="size-4" />}
          title={t('kpiBalance')}
          value={fmtBalance(data.balance)}
          hint={t('kpiBalanceHint')}
        />
        <KpiCard
          icon={<CoinsIcon className="size-4" />}
          title={t('kpiTodayCost')}
          value={fmtBalance(data.todayCost)}
          hint={t('kpiTodayCostHint')}
        />
        <KpiCard
          icon={<KeyRoundIcon className="size-4" />}
          title={t('kpiKeys')}
          value={fmtInt(data.totalKeys)}
          sub={t('kpiActiveKeys', { count: fmtInt(data.activeKeys) })}
          hint={t('kpiKeysHint')}
        />
        <KpiCard
          icon={<GaugeIcon className="size-4" />}
          title={t('kpiRate')}
          value={fmtInt(data.rpm)}
          sub={t('kpiTpm', { count: fmtInt(data.tpm) })}
          hint={t('kpiRateHint', {
            rpm: data.rpmLimit == null ? '∞' : fmtInt(data.rpmLimit),
            tpm: data.tpmLimit == null ? '∞' : fmtInt(data.tpmLimit),
          })}
        />
      </div>

      <Card className="@container/card">
        <CardHeader>
          <CardTitle className="text-base">{t('costTrendTitle')}</CardTitle>
          <CardDescription>{t('costTrendDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <CostChart data={data.dailyCost} />
        </CardContent>
      </Card>

      <Card>
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
  sub?: string;
  hint?: string;
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
        <CardTitle className="text-2xl tabular-nums tracking-tight">{value}</CardTitle>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
    </Card>
  );
}
