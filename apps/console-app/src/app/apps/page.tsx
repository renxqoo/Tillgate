import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch, type Paginated } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CreateAppForm } from './forms';

export const dynamic = 'force-dynamic';

interface AppRow {
  id: number;
  appId: string;
  clientId: string;
  name: string;
  description: string | null;
  scope: { models?: string[]; rpm?: number; tpm?: number } | null;
  status: number;
  createdAt: string;
  rotatedAt: string | null;
}

export default async function AppsPage() {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');

  const apps = await apiFetch<Paginated<AppRow>>('/api/apps?page=1&page_size=100', { cookieHeader: cookie }).catch(() => ({ list: [] as AppRow[], total: 0, page: 1, page_size: 100 }));

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <h1 className="text-2xl font-semibold tracking-tight">应用管理</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">创建应用</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateAppForm />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">已有应用（{apps.total}）</CardTitle>
          </CardHeader>
          <CardContent>
            {apps.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无应用</p>
            ) : (
              <div className="space-y-2">
                {apps.list.map((a) => (
                  <div key={a.id} className="rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{a.name}</span>
                      {a.status === 1 && (
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">已禁用</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      <span>client_id: </span>
                      <code className="rounded bg-muted px-1.5 py-0.5">{a.clientId}</code>
                    </div>
                    {a.scope?.models && a.scope.models.length > 0 && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        模型范围: {a.scope.models.join(', ')}
                      </div>
                    )}
                    <div className="mt-1 text-xs text-muted-foreground">
                      创建于 {new Date(a.createdAt).toLocaleString('zh-CN')}
                      {a.rotatedAt && ` · 最近轮换 ${new Date(a.rotatedAt).toLocaleString('zh-CN')}`}
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
