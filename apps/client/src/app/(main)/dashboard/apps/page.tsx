import { ShieldCheckIcon } from "lucide-react";

import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";
import { ApiError, apiFetch, fmtInt, type AppRow as ApiAppRow, type Paginated } from "@ai-gateway/api-client";

import { type AppRow } from "./types";
import { AppsTable, CreateAppDialog } from "./_components/apps-content";

export const dynamic = "force-dynamic";

export default async function AppsPage() {
  let apps: AppRow[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    const data = await apiFetch<Paginated<ApiAppRow>>("/api/apps?page=1&page_size=100");
    apps = data.list;
    total = data.total;
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ShieldCheckIcon className="size-5 text-muted-foreground" />
            应用
          </h1>
          <p className="text-sm text-muted-foreground">OAuth 风格 client_id / secret（共 {fmtInt(total)} 个）</p>
        </div>
        <CreateAppDialog />
      </div>

      <Card>
        <CardContent className="px-0">
          {error ? <p className="p-8 text-center text-sm text-destructive">{error}</p> : <AppsTable apps={apps} />}
        </CardContent>
      </Card>
    </div>
  );
}
