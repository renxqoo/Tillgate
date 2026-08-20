import { LineChartIcon } from "lucide-react";

import { fmtDateTime, fmtCost, formatPoints, fmtInt, msToHuman, type UsageRow } from "@ai-gateway/api-client";
import { fetchUserList } from "@ai-gateway/api-client/list";
import { DataTable, type DataTableColumn } from "@ai-gateway/ui/components/data-table";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { firstParam, parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UsagePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const model = firstParam(sp.model) ?? "";
  const { rows, total, error } = await fetchUserList<UsageRow>("/v1/usage", {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q, model },
  });

  const columns: DataTableColumn<UsageRow>[] = [
    {
      key: "createdAt",
      header: "时间",
      sortable: true,
      render: (r) => (
        <span className="text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
      ),
    },
    {
      key: "externalModel",
      header: "模型",
      render: (r) => <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.externalModel}</code>,
    },
    {
      key: "source",
      header: "来源",
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {r.credentialType === "key" && r.keyName
            ? `🔑 ${r.keyName}`
            : r.credentialType === "jwt" && r.appName
              ? `📦 ${r.appName}`
              : "—"}
        </span>
      ),
    },
    { key: "inputTokens", header: "输入", align: "right", render: (r) => <span className="text-right tabular-nums">{fmtInt(r.inputTokens)}</span> },
    {
      key: "cachedInputTokens",
      header: "缓存",
      align: "right",
      render: (r) => (
        <span className="text-right tabular-nums text-muted-foreground">
          {r.cachedInputTokens > 0 ? fmtInt(r.cachedInputTokens) : "—"}
        </span>
      ),
    },
    {
      key: "cacheRate",
      header: "缓存率",
      align: "right",
      render: (r) => (
        <span className="text-right tabular-nums text-muted-foreground">
          {r.inputTokens > 0 ? `${((r.cachedInputTokens / r.inputTokens) * 100).toFixed(2)}%` : "—"}
        </span>
      ),
    },
    { key: "outputTokens", header: "输出", align: "right", render: (r) => <span className="text-right tabular-nums">{fmtInt(r.outputTokens)}</span> },
    {
      key: "amount",
      header: "消耗",
      sortable: true,
      align: "right",
      render: (r) => (
        <span className="text-right font-medium tabular-nums">
          {r.billedBy === "plan" ? (
            <>
              {formatPoints(r.planAmount).replace(/\.?0+$/, "")} 积分
              <span className="ml-1 text-xs text-muted-foreground">套餐</span>
            </>
          ) : (
            <>
              ¥{fmtCost(r.paygAmount)}
              <span className="ml-1 text-xs text-muted-foreground">余额</span>
            </>
          )}
        </span>
      ),
    },
    {
      key: "durationMs",
      header: "耗时",
      sortable: true,
      align: "right",
      render: (r) => <span className="text-right tabular-nums text-muted-foreground">{msToHuman(r.durationMs)}</span>,
    },
  ];

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <ListPage
        title="用量"
        icon={<LineChartIcon className="size-5 text-muted-foreground" />}
        total={total}
        totalUnit="条请求"
        searchPlaceholder="搜索模型 / request_id"
        q={q}
        searchParams={{ q, model, sort_by: sortBy, order: sortBy ? order : undefined }}
        error={error}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          sort={{ sortBy, order }}
          searchParams={{ q, model }}
          empty="暂无用量记录"
        />
      </ListPage>
    </div>
  );
}
