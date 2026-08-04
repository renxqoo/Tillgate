import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent } from '@/components/ui/card';
import RateCardActions from './client';
import CreateButton from './create-button';

export const dynamic = 'force-dynamic';

interface RateCardRow {
  id: number;
  name: string;
  description: string | null;
  status: number;
  coefficient: string;
}

export default async function AdminRateCardsPage() {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');
  if (me.role !== 1) redirect('/dashboard');

  const cards = await apiFetch<{ list: RateCardRow[] }>('/api/admin/rate-cards', { cookieHeader: cookie }).catch(() => ({ list: [] }));

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <AdminNav active="rate-cards" />
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">费率卡管理（{cards.list.length}）</h1>
          <CreateButton />
        </div>

        <Card>
          <CardContent className="pt-6">
            {cards.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无费率卡</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4">ID</th>
                      <th className="py-2 pr-4">名称</th>
                      <th className="py-2 pr-4">描述</th>
                      <th className="py-2 pr-4 text-right">全局系数</th>
                      <th className="py-2 pr-4">状态</th>
                      <th className="py-2 pr-4 text-right">操作</th>
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
                          <span className={`rounded px-1.5 py-0.5 text-xs ${c.status === 0 ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                            {c.status === 0 ? '启用' : '停用'}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right">
                          <RateCardActions card={c} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground">
          费率卡决定用户价 = 官方价 × 系数。每卡必有一行全局系数（兜底）。删除前需先迁移绑定的用户。
        </p>
      </main>
    </>
  );
}
