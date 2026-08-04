import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch, type Paginated } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CreateKeyForm, RevokeKeyButton } from './forms';

export const dynamic = 'force-dynamic';

interface KeyRow {
  id: number;
  keyPreview: string;
  name: string;
  remark: string | null;
  status: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export default async function KeysPage() {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');

  const keys = await apiFetch<Paginated<KeyRow>>('/api/keys?page=1&page_size=100', { cookieHeader: cookie }).catch(() => ({ list: [] as KeyRow[], total: 0, page: 1, page_size: 100 }));

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <h1 className="text-2xl font-semibold tracking-tight">Key 管理</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">创建新 Key</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateKeyForm />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">已有 Key（{keys.total}）</CardTitle>
          </CardHeader>
          <CardContent>
            {keys.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无 Key</p>
            ) : (
              <div className="space-y-2">
                {keys.list.map((k) => (
                  <div key={k.id} className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{k.name}</span>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{k.keyPreview}</code>
                        {k.status === 1 && (
                          <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">已吊销</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        创建于 {new Date(k.createdAt).toLocaleString('zh-CN')}
                        {k.expiresAt && ` · 过期 ${new Date(k.expiresAt).toLocaleString('zh-CN')}`}
                        {k.lastUsedAt && ` · 最近使用 ${new Date(k.lastUsedAt).toLocaleString('zh-CN')}`}
                      </div>
                    </div>
                    {k.status === 0 && <RevokeKeyButton id={k.id} />}
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
