import { SearchIcon, UsersRound } from "lucide-react";

import {
  ApiError,
  adminFetch,
  fmtInt,
  type AdminRateCardRow,
  type AdminUserRow,
  type ListResult,
} from "@ai-gateway/api-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ai-gateway/ui/components/ui/card";
import { Input } from "@ai-gateway/ui/components/ui/input";

import { UsersContent } from "./_components/users-content";
import { UsersExport } from "./_components/users-export";
import { UsersStatusFilter } from "./_components/users-status-filter";
import type { RateCardOption, UserRow } from "./types";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ q?: string; status?: string }>;
}

export default async function UsersPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const status = sp.status ?? "all";

  let rows: UserRow[] = [];
  let total = 0;
  let error: string | null = null;
  let rateCards: RateCardOption[] = [];

  try {
    const query = new URLSearchParams({ page: "1", page_size: "100" });
    if (q) query.set("q", q);
    if (status === "0" || status === "1") query.set("status", status);
    if (status === "admin") query.set("role", "1");
    const data = await adminFetch<ListResult<AdminUserRow>>(
      `/api/admin/users?${query.toString()}`,
    );
    rows = data.list ?? [];
    total = data.total ?? rows.length;
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  try {
    const rc = await adminFetch<ListResult<AdminRateCardRow>>("/api/admin/rate-cards");
    rateCards = (rc.list ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      coefficient: r.coefficient,
    }));
  } catch {
    // 费率卡加载失败不阻塞列表
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <UsersRound className="size-5 text-muted-foreground" />
          用户
        </h1>
        <p className="text-sm text-muted-foreground">共 {fmtInt(total)} 个用户</p>
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">用户列表</CardTitle>
              <CardDescription>搜索、封禁 / 解封、调账、赠送、改密、绑定费率卡</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <form method="GET" className="relative">
                <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  name="q"
                  defaultValue={q}
                  placeholder="搜索 subject / email"
                  className="w-56 pl-9"
                />
              </form>
              <UsersStatusFilter value={status} />
              <UsersExport users={rows} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <UsersContent users={rows} initialQuery={q} rateCards={rateCards} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export type { UserRow };
