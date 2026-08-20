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
} from '@ai-gateway/api-client';

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
    const keysData = await apiFetch<Paginated<{ status: number }>>(
      '/v1/keys?page=1&limit=100',
    );
    data.totalKeys = keysData.total;
    const keyRows = keysData.rows ?? [];
    data.activeKeys = keyRows.filter((k) => k.status === 0).length;
  } catch {
    // ignore
  }

  // 按模型聚合用量（v2：/usage/by-model；日费用趋势以模型维度近似，今日费用取总额）
  try {
    const byModel = await apiFetch<{ rows?: UsageByModelItem[]; list?: UsageByModelItem[] }>('/v1/usage/by-model');
    const modelRows = byModel.rows ?? [];
    data.byModel = modelRows;
    const todayTotal = modelRows.reduce((sum, it) => sum + (Number(it.cost) || 0), 0);
    data.dailyCost = [{ date: new Date().toISOString().slice(0, 10), value: todayTotal }];
    data.todayCost = todayTotal;
  } catch {
    // 用量不可达时图表留空
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
            欢迎回来，{me.displayName || me.subject}
          </h1>
          <p className="text-sm text-muted-foreground">这里是您的账户概览</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/redeem">兑换充值码</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/dashboard/keys">创建 API Key</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 @3xl/main:grid-cols-4">
        <KpiCard
          icon={<WalletIcon className="size-4" />}
          title="已结算余额（元）"
          value={fmtBalance(data.balance)}
          hint="在途请求完成结算后更新"
        />
        <KpiCard
          icon={<CoinsIcon className="size-4" />}
          title="今日消耗（元）"
          value={fmtBalance(data.todayCost)}
          hint="今日 API 调用费用"
        />
        <KpiCard
          icon={<KeyRoundIcon className="size-4" />}
          title="API Key"
          value={fmtInt(data.totalKeys)}
          sub={`活跃 ${fmtInt(data.activeKeys)}`}
          hint="当前账号创建的密钥"
        />
        <KpiCard
          icon={<GaugeIcon className="size-4" />}
          title="RPM / TPM"
          value={fmtInt(data.rpm)}
          sub={`TPM ${fmtInt(data.tpm)}`}
          hint={`近 60 秒实际速率 · 限额 ${data.rpmLimit == null ? '∞' : fmtInt(data.rpmLimit)}/${data.tpmLimit == null ? '∞' : fmtInt(data.tpmLimit)}`}
        />
      </div>

      <Card className="@container/card">
        <CardHeader>
          <CardTitle className="text-base">每日费用趋势</CardTitle>
          <CardDescription>按日聚合的请求费用（元）</CardDescription>
        </CardHeader>
        <CardContent>
          <CostChart data={data.dailyCost} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">不同模型用量</CardTitle>
          <CardDescription>近 30 天按模型的费用 / Token / 次数分布</CardDescription>
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
