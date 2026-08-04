import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch, type Paginated, liToYuan } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { AdminNav } from '@/components/admin-nav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

interface UserRow {
  id: number;
  subject: string;
  email: string | null;
  displayName: string | null;
  role: number;
  rateCardName: string | null;
  balance: number;
  status: number;
  createdAt: string;
}

const STATUS_LABEL: Record<number, { label: string; cls: string }> = {
  0: { label: '正常', cls: 'bg-primary/10 text-primary' },
  1: { label: '封禁', cls: 'bg-destructive/10 text-destructive' },
  2: { label: '注销', cls: 'bg-muted text-muted-foreground' },
};

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');
  if (me.role !== 1) redirect('/dashboard');

  const params = await searchParams;
  const q = params.q ?? '';
  const page = Number(params.page ?? '1');
  const query = new URLSearchParams({ page: String(page), page_size: '50' });
  if (q) query.set('q', q);
  const users = await apiFetch<Paginated<UserRow>>(`/api/admin/users?${query}`, { cookieHeader: cookie }).catch(() => ({ list: [] as UserRow[], total: 0, page: 1, page_size: 50 }));

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <AdminNav active="users" />

        <h1 className="text-2xl font-semibold tracking-tight">用户管理（{users.total}）</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">搜索</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="flex gap-2">
              <input
                name="q"
                defaultValue={q}
                placeholder="用户名 / 邮箱 / 昵称"
                className="flex h-9 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              />
              <button type="submit" className="rounded-md bg-primary px-4 text-sm text-primary-foreground">搜索</button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4">ID</th>
                    <th className="py-2 pr-4">用户名</th>
                    <th className="py-2 pr-4">费率卡</th>
                    <th className="py-2 pr-4 text-right">余额</th>
                    <th className="py-2 pr-4">状态</th>
                    <th className="py-2 pr-4">创建时间</th>
                  </tr>
                </thead>
                <tbody>
                  {users.list.map((u) => {
                    const st = STATUS_LABEL[u.status] ?? { label: `状态${u.status}`, cls: 'bg-muted' };
                    return (
                      <tr key={u.id} className="border-b">
                        <td className="py-2 pr-4 font-mono text-xs">{u.id}</td>
                        <td className="py-2 pr-4">
                          {u.displayName ?? u.subject}
                          {u.role === 1 && <span className="ml-1 text-xs text-primary">管理员</span>}
                        </td>
                        <td className="py-2 pr-4 text-xs">{u.rateCardName ?? '-'}</td>
                        <td className="py-2 pr-4 text-right font-mono">¥{liToYuan(u.balance)}</td>
                        <td className="py-2 pr-4">
                          <span className={`rounded px-1.5 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                        </td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground">{new Date(u.createdAt).toLocaleDateString('zh-CN')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
