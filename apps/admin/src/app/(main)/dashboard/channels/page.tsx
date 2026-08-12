import { NetworkIcon } from "lucide-react";

import {
  ApiError,
  adminFetch,
  type AdminChannelRow,
  type AdminProviderRow,
  type ListResult,
} from "@ai-gateway/api-client";
import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";

import {
  ChannelsTable,
  CreateChannelDialog,
  ImportChannelsDialog,
} from "./_components/channels-content";
import type { ChannelRow, ProviderOption } from "./types";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  let channels: ChannelRow[] = [];
  let providers: ProviderOption[] = [];
  let error: string | null = null;

  try {
    const data = await adminFetch<ListResult<AdminChannelRow>>("/api/admin/channels");
    channels = data.list ?? [];
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  try {
    const p = await adminFetch<ListResult<AdminProviderRow>>("/api/admin/providers");
    providers = (p.list ?? []).map((x) => ({
      id: x.id,
      name: x.name,
      baseUrl: x.baseUrl,
      protocol: x.protocol,
      status: x.status,
    }));
  } catch {
    // providers 失败不阻塞
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <NetworkIcon className="size-5 text-muted-foreground" />
            渠道
          </h1>
          <p className="text-sm text-muted-foreground">LLM 供应商渠道管理</p>
        </div>
        <div className="flex items-center gap-2">
          <ImportChannelsDialog />
          <CreateChannelDialog providers={providers} />
        </div>
      </div>

      <Card>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <ChannelsTable channels={channels} providers={providers} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
