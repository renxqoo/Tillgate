import { CalendarClockIcon, SearchIcon } from "lucide-react";

import {
  ApiError,
  adminFetch,
  type AdminSubscriptionRow,
  type Paginated,
} from "@ai-gateway/api-client";
import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";
import { Input } from "@ai-gateway/ui/components/ui/input";

import { SubscriptionsTable } from "./_components/subscriptions-content";
import { SubscriptionsStatusFilter } from "./_components/subscriptions-status-filter";
import type { SubscriptionRow } from "./types";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ page?: string; planId?: string; userId?: string; status?: string }>;
}

export default async function SubscriptionsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const pageSize = 20;
  const planId = sp.planId ? Number(sp.planId) : undefined;
  const userId = (sp.userId ?? "").trim();
  const status = sp.status ?? "all";

  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (planId) query.set("planId", String(planId));
  if (userId) query.set("userId", userId);
  if (status === "0" || status === "1" || status === "2") query.set("status", status);

  let rows: SubscriptionRow[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    const data = await adminFetch<Paginated<AdminSubscriptionRow>>(
      `/api/admin/subscriptions?${query.toString()}`,
    );
    rows = (data.list ?? []).map((r) => ({ ...r }));
    total = data.total ?? 0;
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <CalendarClockIcon className="size-5 text-muted-foreground" />
          订阅
        </h1>
        <p className="text-sm text-muted-foreground">共 {total} 条订阅记录</p>
      </div>

      <Card>
        <CardContent className="px-0">
          <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
            <form method="GET" className="relative">
              <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                name="userId"
                defaultValue={userId}
                placeholder="按用户 ID 筛选"
                className="w-48 pl-9"
              />
              {status !== "all" && <input type="hidden" name="status" value={status} />}
            </form>
            <SubscriptionsStatusFilter value={status} />
          </div>
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <SubscriptionsTable rows={rows} />
          )}
        </CardContent>
      </Card>

      {totalPages > 1 ? <Pager page={page} totalPages={totalPages} /> : null}
    </div>
  );
}

function Pager({ page, totalPages }: { page: number; totalPages: number }) {
  return (
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
  );
}
