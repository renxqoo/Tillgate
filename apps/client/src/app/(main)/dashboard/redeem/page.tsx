import { CoinsIcon, GiftIcon } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ai-gateway/ui/components/ui/table";
import { ApiError, apiFetch, fmtBalance, fmtDateTime, type Paginated, type RedeemHistoryItem } from "@ai-gateway/api-client";

import Link from "next/link";

import { RedeemForm } from "./_components/redeem-form";

export const dynamic = "force-dynamic";

export default async function RedeemPage() {
  let history: RedeemHistoryItem[] = [];
  let error: string | null = null;
  try {
    const data = await apiFetch<Paginated<RedeemHistoryItem>>("/api/redeem/history?page=1&page_size=20");
    history = data.list;
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GiftIcon className="size-5 text-muted-foreground" />
          充值码
        </h1>
        <p className="text-sm text-muted-foreground">兑换充值码，查看兑换记录</p>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <RedeemForm />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CoinsIcon className="size-4 text-muted-foreground" />
              兑换记录
            </CardTitle>
            <CardDescription>
              只显示最近 20 条；完整资金流水见{" "}
              <Link href="/dashboard/transactions" className="underline hover:text-foreground">
                账单流水
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {error ? (
              <p className="p-8 text-center text-sm text-destructive">{error}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">面值</TableHead>
                    <TableHead>批次</TableHead>
                    <TableHead>兑换时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                        暂无兑换记录
                      </TableCell>
                    </TableRow>
                  ) : (
                    history.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="text-right font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                          +¥{fmtBalance(r.amount)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.batchName ?? "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.usedAt ? fmtDateTime(r.usedAt) : "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
