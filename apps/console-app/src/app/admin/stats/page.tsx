import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch, liToYuan } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

interface Overview {
  today: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    successCount: number;
    failedCount: number;
    successRate: number;
  };
  total: { cost: number; requests: number };
  channelHealth: Array<{ status: number; count: number }>;
}

const STATUS_LABEL: Record<number, string> = { 0: '启用', 1: '禁用', 2: '维护', 3: '熔断', 4: '凭据无效' };

export default async function AdminStatsPage() {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');
  if (me.role !== 1) redirect('/dashboard');

  const overview = await apiFetch<Overview>('/api/admin/stats/overview', { cookieHeader: cookie }).catch(() => null);

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">管理后台</h1>
          <p className="text-sm text-muted-foreground">运营数据与管理</p>
        </div>

        <nav className="flex flex-wrap gap-2 text-sm">
          <Link href="/admin/stats" className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground">仪表盘</Link>
          <Link href="/admin/users" className="rounded-md border px-3 py-1.5 hover:bg-muted">用户</Link>
          <Link href="/admin/channels" className="rounded-md border px-3 py-1.5 hover:bg-muted">渠道</Link>
          <Link href="/admin/rate-cards" className="rounded-md border px-3 py-1.5 hover:bg-muted">费率卡</Link>
          <Link href="/admin/redeem-batches" className="rounded-md border px-3 py-1.5 hover:bg-muted">充值码</Link>
        </nav>

        {overview && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>今日请求</CardDescription>
                  <CardTitle className="text-2xl">{overview.today.requests}</CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  成功率 {overview.today.successRate}%
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>今日费用</CardDescription>
                  <CardTitle className="text-2xl">¥{liToYuan(overview.today.cost)}</CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  累计 ¥{liToYuan(overview.total.cost)}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>今日输入 tokens</CardDescription>
                  <CardTitle className="text-2xl">{overview.today.inputTokens.toLocaleString()}</CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">含缓存命中</CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>今日输出 tokens</CardDescription>
                  <CardTitle className="text-2xl">{overview.today.outputTokens.toLocaleString()}</CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">生成量</CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">渠道健康状态</CardTitle>
                <CardDescription>各状态渠道数量</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-3">
                  {overview.channelHealth.map((c) => (
                    <div key={c.status} className="rounded-md border px-3 py-2 text-sm">
                      <span className="text-muted-foreground">{STATUS_LABEL[c.status] ?? `状态${c.status}`}: </span>
                      <span className="font-mono font-medium">{c.count}</span>
                    </div>
                  ))}
                  {overview.channelHealth.length === 0 && (
                    <p className="text-sm text-muted-foreground">暂无渠道</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </>
  );
}
