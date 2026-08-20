import { CoinsIcon } from "lucide-react";

import { unitWord } from "@ai-gateway/api-client/formatters";
import {
  ApiError,
  adminFetch,
  fmtDateTime,
  msToHuman,
  type AdminUsageRow,
  type Paginated,
} from "@ai-gateway/api-client";
import { DataTable, type DataTableColumn } from "@ai-gateway/ui/components/data-table";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { firstParam, parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

import { UsageLogsFilter } from "./_components/usage-logs-filter";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** 估算归属 → 可读文案（管理端观测：这笔为什么按估算扣） */
function estimateReasonText(reason: string | null): string {
  switch (reason) {
    case "client_disconnect":
    case "request_cancelled":
    case "aborted":
      return "请求提前取消，按已交付内容估算";
    case "usage_missing_completed":
      return "供应商未返回用量（正常完成），按已交付内容估算";
    case "usage_missing_nonstream":
      return "供应商未返回用量（非流式），按响应内容估算";
    default:
      return "估算结算";
  }
}

export default async function UsageLogsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const from = firstParam(sp.from) ?? "";
  const to = firstParam(sp.to) ?? "";
  const userId = firstParam(sp.userId) ?? "";
  const estimated = firstParam(sp.estimated) ?? "";
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(PAGE_SIZE),
    sort_by: sortBy ?? "createdAt",
    order,
  });
  if (q) query.set("q", q);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  if (userId) query.set("userId", userId);
  if (estimated) query.set("estimated", estimated);

  let rows: AdminUsageRow[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    const data = await adminFetch<Paginated<AdminUsageRow>>(
      `/v1/usage-logs?${query.toString()}`,
    );
    rows = data.rows ?? [];
    total = data.total ?? 0;
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  const columns: DataTableColumn<AdminUsageRow>[] = [
    {
      key: "requestId",
      header: "Request ID",
      render: (r) => <code className="text-xs text-muted-foreground">{r.requestId.slice(0, 8)}</code>,
    },
    {
      key: "userName",
      header: "用户",
      render: (r) => (
        <span className="text-xs">{r.userName ?? (r.userId ? `#${r.userId}` : "—")}</span>
      ),
    },
    {
      key: "externalModel",
      header: "模型",
      render: (r) => (
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.externalModel}</code>
      ),
    },
    {
      key: "inputTokens",
      header: "输入",
      sortable: true,
      align: "right",
      render: (r) =>
        r.units && r.units > 0 ? (
          <span className="text-right text-xs tabular-nums">
            {r.units.toLocaleString()} {unitWord(r.pricingUnit)}
            <span className="ml-1 text-muted-foreground">(单位计价)</span>
          </span>
        ) : (
          <span className="text-right text-xs tabular-nums">
            {r.inputTokens.toLocaleString()}
            {r.cachedInputTokens > 0 ? (
              <span className="ml-1 text-muted-foreground">(缓存 {r.cachedInputTokens.toLocaleString()})</span>
            ) : null}
          </span>
        ),
    },
    {
      key: "outputTokens",
      header: "输出",
      sortable: true,
      align: "right",
      render: (r) =>
        r.units && r.units > 0 ? (
          <span className="text-right text-xs tabular-nums text-muted-foreground">
            {r.unitPrice ? `¥${Number(r.unitPrice).toFixed(2)}/${unitWord(r.pricingUnit)}` : '—'}
          </span>
        ) : (
          <span className="text-right text-xs tabular-nums">{r.outputTokens.toLocaleString()}</span>
        ),
    },
    {
      key: "amount",
      header: "扣费",
      sortable: true,
      align: "right",
      render: (r) => (
        <span className="text-right text-xs font-medium tabular-nums">
          ¥{Number(r.amount).toFixed(6)}
          {r.estimated ? (
            <span
              title={estimateReasonText(r.estimateReason)}
              className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] leading-4 text-amber-700 dark:text-amber-300"
            >
              估算
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "billedBy",
      header: "来源",
      render: (r) => (
        <span className="text-xs text-muted-foreground">{r.billedBy === "plan" ? "套餐" : "余额"}</span>
      ),
    },
    {
      key: "durationMs",
      header: "耗时",
      sortable: true,
      align: "right",
      render: (r) => (
        <span className="text-right text-xs tabular-nums text-muted-foreground">
          {msToHuman(r.durationMs)}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: "时间",
      sortable: true,
      headerClassName: "w-44",
      render: (r) => <span className="text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>,
    },
  ];

  return (
    <ListPage
      title="用量明细"
      icon={<CoinsIcon className="size-5 text-muted-foreground" />}
      description="每一笔扣款（含估算扣款）；估算 = 供应商未回传 usage 或请求取消，按已交付内容估算计费"
      total={total}
      searchPlaceholder="搜索模型 / Request ID"
      q={q}
      searchParams={{
        q,
        from,
        to,
        userId,
        estimated,
        sort_by: sortBy,
        order: sortBy ? order : undefined,
      }}
      filters={<UsageLogsFilter from={from} to={to} userId={userId} estimated={estimated} />}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        sort={{ sortBy, order }}
        searchParams={{ q, from, to, userId, estimated }}
        empty="暂无用量记录"
      />
    </ListPage>
  );
}
