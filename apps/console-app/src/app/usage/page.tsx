import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getMe, getCookieHeader, apiFetch, type Paginated, liToYuan } from '@/lib/api-client';
import { SiteHeader } from '@/components/site-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

interface UsageRow {
  id: number;
  externalModel: string;
  realModel: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  tokensEstimated: boolean;
  amount: number;
  durationMs: number;
  stream: boolean;
  status: number;
  createdAt: string;
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const h = await headers();
  const cookie = getCookieHeader(h);
  const me = await getMe(cookie);
  if (!me) redirect('/login');

  const params = await searchParams;
  const page = Number(params.page ?? '1');
  const usage = await apiFetch<Paginated<UsageRow>>(`/api/usage?page=${page}&page_size=20`, { cookieHeader: cookie }).catch(() => ({ list: [] as UsageRow[], total: 0, page: 1, page_size: 20 }));

  return (
    <>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-6xl space-y-6 p-4">
        <h1 className="text-2xl font-semibold tracking-tight">用量明细</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">消费记录（共 {usage.total} 条）</CardTitle>
          </CardHeader>
          <CardContent>
            {usage.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无消费记录</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4">时间</th>
                      <th className="py-2 pr-4">模型</th>
                      <th className="py-2 pr-4 text-right">输入</th>
                      <th className="py-2 pr-4 text-right">输出</th>
                      <th className="py-2 pr-4 text-right">费用</th>
                      <th className="py-2 pr-4 text-right">耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.list.map((u) => (
                      <tr key={u.id} className="border-b">
                        <td className="py-2 pr-4 text-xs text-muted-foreground">
                          {new Date(u.createdAt).toLocaleString('zh-CN')}
                        </td>
                        <td className="py-2 pr-4">{u.externalModel}</td>
                        <td className="py-2 pr-4 text-right font-mono text-xs">
                          {u.inputTokens}
                          {u.cachedInputTokens > 0 && <span className="text-muted-foreground"> ({u.cachedInputTokens} cached)</span>}
                        </td>
                        <td className="py-2 pr-4 text-right font-mono text-xs">{u.outputTokens}</td>
                        <td className="py-2 pr-4 text-right font-mono">¥{liToYuan(u.amount)}</td>
                        <td className="py-2 pr-4 text-right font-mono text-xs">{u.durationMs}ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {usage.total > usage.page_size && (
              <div className="mt-4 flex gap-2 text-sm">
                {page > 1 && <a href={`/usage?page=${page - 1}`} className="text-primary hover:underline">上一页</a>}
                <span className="text-muted-foreground">第 {page} 页</span>
                {page * usage.page_size < usage.total && <a href={`/usage?page=${page + 1}`} className="text-primary hover:underline">下一页</a>}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
