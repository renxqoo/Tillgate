import { TicketIcon } from "lucide-react";

import {
  ApiError,
  adminFetch,
  type AdminBatchRow,
  type ListResult,
} from "@ai-gateway/api-client";
import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";

import { BatchesTable, GenerateBatchDialog } from "./_components/redeem-batches-content";
import type { RedeemBatchRow } from "./types";

export const dynamic = "force-dynamic";

export default async function RedeemBatchesPage() {
  let batches: RedeemBatchRow[] = [];
  let error: string | null = null;
  try {
    const data = await adminFetch<ListResult<AdminBatchRow>>("/api/admin/redeem-batches");
    batches = data.list ?? [];
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <TicketIcon className="size-5 text-muted-foreground" />
            充值码批次
          </h1>
          <p className="text-sm text-muted-foreground">批量生成充值码用于赠送 / 活动</p>
        </div>
        <GenerateBatchDialog />
      </div>
      <Card>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <BatchesTable batches={batches} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
