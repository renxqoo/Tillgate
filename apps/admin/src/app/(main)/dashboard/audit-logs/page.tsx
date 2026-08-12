import { HistoryIcon } from "lucide-react";

import {
  ApiError,
  adminFetch,
  fmtDateTime,
  type AuditLogRow,
  type Paginated,
} from "@ai-gateway/api-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ai-gateway/ui/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ai-gateway/ui/components/ui/table";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function AuditLogsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const query = new URLSearchParams({ page: String(page), page_size: "50" });

  let rows: AuditLogRow[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    const data = await adminFetch<Paginated<AuditLogRow>>(`/api/admin/audit-logs?${query.toString()}`);
    rows = data.list ?? [];
    total = data.total ?? 0;
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  const totalPages = Math.max(1, Math.ceil(total / 50));

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <HistoryIcon className="size-5 text-muted-foreground" />
          操作审计
        </h1>
        <p className="text-sm text-muted-foreground">共 {total} 条记录</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">操作审计日志</CardTitle>
          <CardDescription>记录管理员对系统对象的所有写操作</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead>管理员</TableHead>
                  <TableHead className="w-48">动作</TableHead>
                  <TableHead className="w-32">目标类型</TableHead>
                  <TableHead className="w-24">目标 ID</TableHead>
                  <TableHead>详情</TableHead>
                  <TableHead className="w-44">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      暂无审计日志
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">#{a.id}</TableCell>
                      <TableCell className="text-xs">{a.actor ?? a.adminSubject ?? "—"}</TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.action}</code>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{a.targetType}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{a.targetId}</TableCell>
                      <TableCell className="max-w-md text-xs text-muted-foreground">
                        {a.detail ? JSON.stringify(a.detail) : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtDateTime(a.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            第 {page} / {totalPages} 页
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <a href={`?page=${page - 1}`} className="rounded-md border px-3 py-1 hover:bg-muted">
                上一页
              </a>
            ) : null}
            {page < totalPages ? (
              <a href={`?page=${page + 1}`} className="rounded-md border px-3 py-1 hover:bg-muted">
                下一页
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
