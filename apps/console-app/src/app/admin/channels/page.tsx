import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<number, string> = { 0: '启用', 1: '禁用', 2: '维护', 3: '熔断', 4: '凭据无效' };

export default async function AdminChannelsPage() {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');
  if (me.role !== 1) redirect('/dashboard');

  const channels = await apiFetch<{ list: Array<{ id: number; name: string; providerName: string; status: number; failCount: number; weight: number; priority: number; cooldownUntil: string | null }> }>(
    '/api/admin/channels',
    { cookieHeader: cookie },
  ).catch(() => ({ list: [] }));

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <AdminNav active="channels" />
        <h1 className="text-2xl font-semibold tracking-tight">渠道管理（{channels.list.length}）</h1>

        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4">ID</th>
                    <th className="py-2 pr-4">名称</th>
                    <th className="py-2 pr-4">供应商</th>
                    <th className="py-2 pr-4">状态</th>
                    <th className="py-2 pr-4 text-right">权重</th>
                    <th className="py-2 pr-4 text-right">优先级</th>
                    <th className="py-2 pr-4 text-right">失败次数</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.list.map((c) => (
                    <tr key={c.id} className="border-b">
                      <td className="py-2 pr-4 font-mono text-xs">{c.id}</td>
                      <td className="py-2 pr-4">{c.name}</td>
                      <td className="py-2 pr-4 text-xs">{c.providerName}</td>
                      <td className="py-2 pr-4">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{STATUS_LABEL[c.status] ?? `状态${c.status}`}</span>
                        {c.cooldownUntil && <span className="ml-1 text-xs text-muted-foreground">熔断中</span>}
                      </td>
                      <td className="py-2 pr-4 text-right font-mono">{c.weight}</td>
                      <td className="py-2 pr-4 text-right font-mono">{c.priority}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs">{c.failCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              渠道 CRUD 与批量导入请通过 admin-api 操作（一期控制台只读展示）
            </p>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
