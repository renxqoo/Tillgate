import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function AdminRateCardsPage() {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');
  if (me.role !== 1) redirect('/dashboard');

  const cards = await apiFetch<{ list: Array<{ id: number; name: string; description: string | null; status: number; coefficient: string }> }>(
    '/api/admin/rate-cards',
    { cookieHeader: cookie },
  ).catch(() => ({ list: [] }));

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <AdminNav active="rate-cards" />
        <h1 className="text-2xl font-semibold tracking-tight">费率卡管理（{cards.list.length}）</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">费率卡列表</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4">ID</th>
                    <th className="py-2 pr-4">名称</th>
                    <th className="py-2 pr-4">描述</th>
                    <th className="py-2 pr-4 text-right">全局系数</th>
                    <th className="py-2 pr-4">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {cards.list.map((c) => (
                    <tr key={c.id} className="border-b">
                      <td className="py-2 pr-4 font-mono text-xs">{c.id}</td>
                      <td className="py-2 pr-4 font-medium">{c.name}</td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{c.description ?? '-'}</td>
                      <td className="py-2 pr-4 text-right font-mono">{c.coefficient}x</td>
                      <td className="py-2 pr-4">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{c.status === 0 ? '启用' : '停用'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
