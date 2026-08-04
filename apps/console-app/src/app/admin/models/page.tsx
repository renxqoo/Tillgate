import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent } from '@/components/ui/card';
import ModelActions from './client';
import CreateButton from './create-button';

export const dynamic = 'force-dynamic';

interface ModelRow {
  id: number;
  externalName: string;
  realModel: string;
  status: number;
  inputPrice: number;
  outputPrice: number;
  cacheInputPrice: number;
}

export default async function AdminModelsPage() {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');
  if (me.role !== 1) redirect('/dashboard');

  const models = await apiFetch<{ list: ModelRow[] }>('/api/admin/models', { cookieHeader: cookie }).catch(() => ({ list: [] }));

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <AdminNav active="models" />
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">模型映射（{models.list.length}）</h1>
          <CreateButton />
        </div>

        <Card>
          <CardContent className="pt-6">
            {models.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无模型映射</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4">ID</th>
                      <th className="py-2 pr-4">对外模型名</th>
                      <th className="py-2 pr-4">真实模型名</th>
                      <th className="py-2 pr-4 text-right">输入价</th>
                      <th className="py-2 pr-4 text-right">输出价</th>
                      <th className="py-2 pr-4 text-right">缓存价</th>
                      <th className="py-2 pr-4">状态</th>
                      <th className="py-2 pr-4 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.list.map((m) => (
                      <tr key={m.id} className="border-b">
                        <td className="py-2 pr-4 font-mono text-xs">{m.id}</td>
                        <td className="py-2 pr-4 font-medium">{m.externalName}</td>
                        <td className="py-2 pr-4 text-xs font-mono">{m.realModel}</td>
                        <td className="py-2 pr-4 text-right font-mono text-xs">{m.inputPrice}</td>
                        <td className="py-2 pr-4 text-right font-mono text-xs">{m.outputPrice}</td>
                        <td className="py-2 pr-4 text-right font-mono text-xs">{m.cacheInputPrice}</td>
                        <td className="py-2 pr-4">
                          <span className={`rounded px-1.5 py-0.5 text-xs ${m.status === 0 ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                            {m.status === 0 ? '上架' : '下架'}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right">
                          <ModelActions model={m} />
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
          价格单位：厘/百万 token（1 元 = 1000 厘）。对外模型名是客户端在 <code>model</code> 字段填的名字，映射到上游真实模型 + 渠道。
        </p>
      </main>
    </>
  );
}
