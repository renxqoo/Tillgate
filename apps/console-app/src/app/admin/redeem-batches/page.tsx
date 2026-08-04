import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch, type Paginated, liToYuan } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent } from '@/components/ui/card';
import GenerateButton from './generate-button';

export const dynamic = 'force-dynamic';

interface BatchRow {
  id: number;
  name: string;
  remark: string | null;
  amount: number;
  total: number;
  usedCount: number;
  createdAt: string;
}

export default async function AdminRedeemBatchesPage() {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');
  if (me.role !== 1) redirect('/dashboard');

  const batches = await apiFetch<Paginated<BatchRow>>('/api/admin/redeem-batches?page=1&page_size=50', { cookieHeader: cookie }).catch(() => ({ list: [] as BatchRow[], total: 0, page: 1, page_size: 50 }));

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <AdminNav active="redeem-batches" />
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">充值码批次（{batches.total}）</h1>
          <GenerateButton />
        </div>

        <Card>
          <CardContent className="pt-6">
            {batches.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无批次，点击右上角「生成批次」创建</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4">ID</th>
                      <th className="py-2 pr-4">名称</th>
                      <th className="py-2 pr-4 text-right">面额</th>
                      <th className="py-2 pr-4 text-right">总数</th>
                      <th className="py-2 pr-4 text-right">已用</th>
                      <th className="py-2 pr-4 text-right">使用率</th>
                      <th className="py-2 pr-4">创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.list.map((b) => {
                      const rate = b.total > 0 ? Math.round((b.usedCount / b.total) * 100) : 0;
                      return (
                        <tr key={b.id} className="border-b">
                          <td className="py-2 pr-4 font-mono text-xs">{b.id}</td>
                          <td className="py-2 pr-4 font-medium">{b.name}</td>
                          <td className="py-2 pr-4 text-right font-mono">¥{liToYuan(b.amount)}</td>
                          <td className="py-2 pr-4 text-right font-mono">{b.total}</td>
                          <td className="py-2 pr-4 text-right font-mono">{b.usedCount}</td>
                          <td className="py-2 pr-4 text-right">
                            <span className={`rounded px-1.5 py-0.5 text-xs ${rate === 100 ? 'bg-primary/10 text-primary' : rate > 0 ? 'bg-muted' : 'bg-muted/50 text-muted-foreground'}`}>
                              {rate}%
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-xs text-muted-foreground">{new Date(b.createdAt).toLocaleString('zh-CN')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
