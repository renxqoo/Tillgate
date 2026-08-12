import { LineChartIcon } from "lucide-react";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ai-gateway/ui/components/ui/table";
import { ApiError, apiFetch, fmtCost, fmtInt, msToHuman, type Paginated, type UsageRow } from "@ai-gateway/api-client";

import Link from "next/link";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function UsagePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const pageSize = 20;

  let rows: UsageRow[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    const data = await apiFetch<Paginated<UsageRow>>(
      `/api/usage?page=${page}&page_size=${pageSize}`,
    );
    rows = data.list;
    total = data.total;
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <LineChartIcon className="size-5 text-muted-foreground" />
          用量
        </h1>
        <p className="text-sm text-muted-foreground">
          共 {fmtInt(total)} 条请求
        </p>
      </div>

      <Card>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead className="text-right">输入</TableHead>
                  <TableHead className="text-right">缓存</TableHead>
                  <TableHead className="text-right">缓存率</TableHead>
                  <TableHead className="text-right">输出</TableHead>
                  <TableHead className="text-right">费用</TableHead>
                  <TableHead className="text-right">耗时</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                        <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                      暂无用量记录
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString("zh-CN")}
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.externalModel}</code>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.credentialType === "key" && r.keyName
                          ? `🔑 ${r.keyName}`
                          : r.credentialType === "jwt" && r.appName
                            ? `📦 ${r.appName}`
                            : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.inputTokens)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.cachedInputTokens > 0 ? fmtInt(r.cachedInputTokens) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {r.inputTokens > 0
                          ? `${((r.cachedInputTokens / r.inputTokens) * 100).toFixed(2)}%`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtInt(r.outputTokens)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        ¥{fmtCost(r.amount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {msToHuman(r.durationMs)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {total > pageSize && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            第 {page} / {totalPages} 页
          </p>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" disabled={page <= 1}>
              <Link href={`/dashboard/usage?page=${page - 1}`}>上一页</Link>
            </Button>
            <Button asChild variant="outline" size="sm" disabled={page >= totalPages}>
              <Link href={`/dashboard/usage?page=${page + 1}`}>下一页</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
