import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch, type Paginated, liToYuan } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent } from '@/components/ui/card';

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
        <h1 className="text-2xl font-semibold tracking-tight">充值码批次（{batches.total}）</h1>

        <Card>
          <CardContent className="pt-6">
            {batches.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无批次</p>
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
                      <th className="py-2 pr-4">创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.list.map((b) => (
                      <tr key={b.id} className="border-b">
                        <td className="py-2 pr-4 font-mono text-xs">{b.id}</td>
                        <td className="py-2 pr-4">{b.name}</td>
                        <td className="py-2 pr-4 text-right font-mono">¥{liToYuan(b.amount)}</td>
                        <td className="py-2 pr-4 text-right font-mono">{b.total}</td>
                        <td className="py-2 pr-4 text-right font-mono">
                          {b.usedCount}
                          <span className="text-muted-foreground"> / {b.total}</span>
                        </td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground">{new Date(b.createdAt).toLocaleString('zh-CN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-4 text-xs text-muted-foreground">
              生成充值码批次请通过 admin-api POST /api/admin/redeem-batches（明文码仅返回一次）
            </p>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
