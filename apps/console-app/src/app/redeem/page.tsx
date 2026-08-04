import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, liToYuan, apiFetch, type Paginated } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RedeemForm } from './forms';

export const dynamic = 'force-dynamic';

interface TxRow {
  id: number;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  remark: string | null;
  createdAt: string;
}

export default async function RedeemPage() {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');

  const txs = await apiFetch<Paginated<TxRow>>('/api/me/transactions?page=1&page_size=20', { cookieHeader: cookie }).catch(() => ({ list: [] as TxRow[], total: 0, page: 1, page_size: 20 }));

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <h1 className="text-2xl font-semibold tracking-tight">充值</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">兑换充值码</CardTitle>
            <CardDescription>输入充值码，兑换后余额即时增加</CardDescription>
          </CardHeader>
          <CardContent>
            <RedeemForm />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">资金流水（共 {txs.total} 条）</CardTitle>
          </CardHeader>
          <CardContent>
            {txs.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无流水</p>
            ) : (
              <div className="space-y-2">
                {txs.list.map((t) => (
                  <div key={t.id} className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{t.type}</span>
                        {t.remark && <span className="text-sm">{t.remark}</span>}
                      </div>
                      <div className="text-xs text-muted-foreground">{new Date(t.createdAt).toLocaleString('zh-CN')}</div>
                    </div>
                    <div className="text-right">
                      <div className={`font-mono ${t.amount > 0 ? 'text-primary' : 'text-destructive'}`}>
                        {t.amount > 0 ? '+' : ''}¥{liToYuan(t.amount)}
                      </div>
                      <div className="text-xs text-muted-foreground">余额 ¥{liToYuan(t.balanceAfter)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
