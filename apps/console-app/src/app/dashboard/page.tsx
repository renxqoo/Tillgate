import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, fmtBalance } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

/**
 * 用户面板首页：余额、今日用量、模型列表、快捷入口。
 */
export default async function DashboardPage() {
  const h = await headers();
  const me = await getMe(getCookieHeader(h));
  if (!me) redirect('/login');

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">仪表盘</h1>
          <p className="text-sm text-muted-foreground">欢迎回来，{me.displayName ?? me.subject}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>当前余额</CardDescription>
              <CardTitle className="text-2xl">¥{fmtBalance(me.balance)}</CardTitle>
            </CardHeader>
            <CardContent>
              <Link href="/redeem" className="text-sm text-primary hover:underline">
                去充值 →
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>费率卡</CardDescription>
              <CardTitle className="text-lg">{me.rateCardName ?? '未绑定'}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">定价系数由费率卡决定</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>限流</CardDescription>
              <CardTitle className="text-lg">
                {me.rpmLimit ? `${me.rpmLimit} RPM` : '默认 60 RPM'}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {me.tpmLimit ? `${me.tpmLimit} TPM` : '默认 1M TPM'}
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <QuickLink href="/keys" title="Key 管理" desc="创建 / 吊销虚拟 Key" />
          <QuickLink href="/apps" title="应用" desc="App 凭证与 JWT 换取" />
          <QuickLink href="/usage" title="用量明细" desc="消费记录与统计" />
          <QuickLink href="/redeem" title="充值" desc="兑换充值码" />
        </div>

        {me.role === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>管理后台</CardTitle>
              <CardDescription>管理员可见</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/admin/stats" className="text-sm text-primary hover:underline">
                进入管理后台 →
              </Link>
            </CardContent>
          </Card>
        )}
      </main>
    </>
  );
}

function QuickLink({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link href={href}>
      <Card className="transition-colors hover:border-primary">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">{desc}</CardContent>
      </Card>
    </Link>
  );
}
