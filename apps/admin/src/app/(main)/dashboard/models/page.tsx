import { CpuIcon } from "lucide-react";

import {
  ApiError,
  adminFetch,
  type AdminChannelRow,
  type AdminModelRow,
  type ListResult,
} from "@ai-gateway/api-client";
import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";

import { CreateModelDialog, ModelsTable } from "./_components/models-content";
import type { ChannelOption, ModelRow } from "./types";

export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  let models: ModelRow[] = [];
  let channels: ChannelOption[] = [];
  let error: string | null = null;

  try {
    const data = await adminFetch<ListResult<AdminModelRow>>("/api/admin/models");
    models = data.list ?? [];
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  try {
    const c = await adminFetch<ListResult<AdminChannelRow>>("/api/admin/channels");
    channels = (c.list ?? []).map((x) => ({ id: x.id, name: x.name, providerName: x.providerName }));
  } catch {
    // channels 失败不阻塞
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <CpuIcon className="size-5 text-muted-foreground" />
            模型映射
          </h1>
          <p className="text-sm text-muted-foreground">外部模型名 → 上游真实模型 + 单价</p>
        </div>
        <CreateModelDialog />
      </div>
      <Card>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <ModelsTable models={models} channels={channels} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
