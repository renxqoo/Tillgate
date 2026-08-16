import { CoinsIcon, GiftIcon } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";
import { DataTable, type DataTableColumn } from "@ai-gateway/ui/components/data-table";
import { Pager } from "@ai-gateway/ui/components/ui/pager";
import { fmtBalance, fmtDateTime, type RedeemHistoryItem } from "@ai-gateway/api-client";
import { fetchUserList } from "@ai-gateway/api-client/list";
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

import Link from "next/link";

import { RedeemForm } from "./_components/redeem-form";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RedeemPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { page, sortBy, order } = parseListSearchParams(sp);
  const { rows: history, total, error } = await fetchUserList<RedeemHistoryItem>(
    "/api/redeem/history",
    { page, pageSize: PAGE_SIZE, sortBy, order },
  );

  const columns: DataTableColumn<RedeemHistoryItem>[] = [
    {
      key: "amount",
      header: "面值",
      align: "right",
      render: (r) => (
        <span className="text-right font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
          +¥{fmtBalance(r.amount)}
        </span>
      ),
    },
    {
      key: "batchName",
      header: "批次",
      render: (r) => <span className="text-sm text-muted-foreground">{r.batchName ?? "—"}</span>,
    },
    {
      key: "usedAt",
      header: "兑换时间",
      sortable: true,
      render: (r) => <span className="text-xs text-muted-foreground">{fmtDateTime(r.usedAt)}</span>,
    },
  ];

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
              完整资金流水见{" "}
              <Link href="/dashboard/transactions" className="underline hover:text-foreground">
                账单流水
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {error ? (
              <p className="p-8 text-center text-sm text-destructive">{error}</p>
            ) : (
              <DataTable
                columns={columns}
                rows={history}
                rowKey={(r) => r.id}
                sort={{ sortBy, order }}
                searchParams={{ sort_by: sortBy, order: sortBy ? order : undefined }}
                empty="暂无兑换记录"
              />
            )}
          </CardContent>
          {total > PAGE_SIZE ? (
            <CardContent className="px-6 pb-4 pt-0">
              <Pager page={page} totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))} total={total} />
            </CardContent>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
