import { ServerIcon } from "lucide-react";

import {
  ApiError,
  adminFetch,
  type AdminProviderRow,
  type ListResult,
} from "@ai-gateway/api-client";
import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";

import { CreateProviderDialog, ProvidersTable } from "./_components/providers-content";
import type { ProviderRow } from "./types";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  let providers: ProviderRow[] = [];
  let error: string | null = null;
  try {
    const data = await adminFetch<ListResult<AdminProviderRow>>("/api/admin/providers");
    providers = data.list ?? [];
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ServerIcon className="size-5 text-muted-foreground" />
            供应商
          </h1>
          <p className="text-sm text-muted-foreground">LLM 供应商入口（baseUrl + 协议）</p>
        </div>
        <CreateProviderDialog />
      </div>

      <Card>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <ProvidersTable providers={providers} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
