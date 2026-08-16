import { HistoryIcon } from "lucide-react";

import { fetchAdminList } from "@ai-gateway/api-client/list";
import type { AuditLogRow } from "@ai-gateway/api-client";
import { fmtDateTime } from "@ai-gateway/api-client";
import { DataTable, type DataTableColumn } from "@ai-gateway/ui/components/data-table";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AuditLogsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows, total, error } = await fetchAdminList<AuditLogRow>("/api/admin/audit-logs", {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });

  const columns: DataTableColumn<AuditLogRow>[] = [
    { key: "id", header: "ID", sortable: true, headerClassName: "w-16", render: (a) => <span className="text-xs text-muted-foreground tabular-nums">#{a.id}</span> },
    { key: "actor", header: "管理员", render: (a) => <span className="text-xs">{a.actor ?? a.adminSubject ?? "—"}</span> },
    { key: "action", header: "动作", sortable: true, headerClassName: "w-48", render: (a) => <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.action}</code> },
    { key: "targetType", header: "目标类型", headerClassName: "w-32", render: (a) => <span className="text-xs text-muted-foreground">{a.targetType}</span> },
    { key: "targetId", header: "目标 ID", headerClassName: "w-24", render: (a) => <span className="text-xs text-muted-foreground">{a.targetId}</span> },
    { key: "detail", header: "详情", render: (a) => <span className="max-w-md truncate text-xs text-muted-foreground">{a.detail ? JSON.stringify(a.detail) : "—"}</span> },
    { key: "createdAt", header: "时间", sortable: true, headerClassName: "w-44", render: (a) => <span className="text-xs text-muted-foreground">{fmtDateTime(a.createdAt)}</span> },
  ];

  return (
    <ListPage
      title="操作审计"
      icon={<HistoryIcon className="size-5 text-muted-foreground" />}
      description="记录管理员对系统对象的所有写操作"
      total={total}
      searchPlaceholder="搜索动作 / 目标类型 / 目标 ID"
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(a) => a.id}
        sort={{ sortBy, order }}
        searchParams={{ q }}
        empty="暂无审计日志"
      />
    </ListPage>
  );
}
