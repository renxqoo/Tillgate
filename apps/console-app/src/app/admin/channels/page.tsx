import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent } from '@/components/ui/card';
import ChannelActions from './client';
import ChannelButtons from './buttons';

export const dynamic = 'force-dynamic';

interface ChannelRow {
  id: number;
  name: string;
  providerName: string;
  status: number;
  failCount: number;
  weight: number;
  priority: number;
  cooldownUntil: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  baseUrlOverride: string | null;
}

const STATUS_LABEL: Record<number, { label: string; cls: string }> = {
  0: { label: '启用', cls: 'bg-primary/10 text-primary' },
  1: { label: '禁用', cls: 'bg-muted text-muted-foreground' },
  2: { label: '维护', cls: 'bg-yellow-500/10 text-yellow-700' },
  3: { label: '熔断', cls: 'bg-orange-500/10 text-orange-700' },
  4: { label: '凭据无效', cls: 'bg-destructive/10 text-destructive' },
};

export default async function AdminChannelsPage() {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');
  if (me.role !== 1) redirect('/dashboard');

  const channels = await apiFetch<{ list: ChannelRow[] }>('/api/admin/channels', { cookieHeader: cookie }).catch(() => ({ list: [] }));
  const providersRes = await apiFetch<{ list: Array<{ id: number; name: string }> }>('/api/admin/providers', { cookieHeader: cookie }).catch(() => ({ list: [] }));

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <AdminNav active="channels" />
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">渠道管理（{channels.list.length}）</h1>
          <ChannelButtons providers={providersRes.list} />
        </div>

        <Card>
          <CardContent className="pt-6">
            {channels.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无渠道</p>
            ) : (
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
                      <th className="py-2 pr-4 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels.list.map((c) => {
                      const st = STATUS_LABEL[c.status] ?? { label: `状态${c.status}`, cls: 'bg-muted' };
                      return (
                        <tr key={c.id} className="border-b">
                          <td className="py-2 pr-4 font-mono text-xs">{c.id}</td>
                          <td className="py-2 pr-4">{c.name}</td>
                          <td className="py-2 pr-4 text-xs">{c.providerName}</td>
                          <td className="py-2 pr-4">
                            <span className={`rounded px-1.5 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                            {c.cooldownUntil && <span className="ml-1 text-xs text-muted-foreground">熔断中</span>}
                          </td>
                          <td className="py-2 pr-4 text-right font-mono">{c.weight}</td>
                          <td className="py-2 pr-4 text-right font-mono">{c.priority}</td>
                          <td className="py-2 pr-4 text-right font-mono text-xs">{c.failCount}</td>
                          <td className="py-2 pr-4 text-right">
                            <ChannelActions channel={c} />
                          </td>
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
