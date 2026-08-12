import { CoinsIcon } from "lucide-react";

import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ai-gateway/ui/components/ui/table";
import { ApiError, apiFetch, fmtBalance, fmtDateTime, type Paginated, type TransactionRow } from "@ai-gateway/api-client";

import Link from "next/link";
import { Button } from "@ai-gateway/ui/components/ui/button";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  redeem: "充值",
  gift: "赠送",
  consume: "消费",
  refund: "退款",
  adjust: "调账",
};

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const pageSize = 50;

  let rows: TransactionRow[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    const data = await apiFetch<Paginated<TransactionRow>>(
      `/api/me/transactions?page=${page}&page_size=${pageSize}`,
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
          <CoinsIcon className="size-5 text-muted-foreground" />
          账单流水
        </h1>
        <p className="text-sm text-muted-foreground">账户余额变动记录</p>
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
                  <TableHead>类型</TableHead>
                  <TableHead>说明</TableHead>
                  <TableHead className="text-right">金额（元）</TableHead>
                  <TableHead className="text-right">余额后</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      暂无流水
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtDateTime(t.createdAt)}
                      </TableCell>
                      <TableCell>{TYPE_LABEL[t.type] ?? t.type}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">{t.remark ?? "—"}</TableCell>
                      <TableCell
                        className={
                          "text-right tabular-nums font-medium " +
                          (t.amount.startsWith("-") ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")
                        }
                      >
                        {t.amount.startsWith("-") ? t.amount : `+${t.amount}`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmtBalance(t.balanceAfter)}
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
              <Link href={`/dashboard/transactions?page=${page - 1}`}>上一页</Link>
            </Button>
            <Button asChild variant="outline" size="sm" disabled={page >= totalPages}>
              <Link href={`/dashboard/transactions?page=${page + 1}`}>下一页</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
