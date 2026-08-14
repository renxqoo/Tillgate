import { GemIcon } from "lucide-react";

import {
  ApiError,
  adminFetch,
  type ListResult,
  type PlanRow as ApiPlanRow,
} from "@ai-gateway/api-client";
import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";

import { CreatePlanDialog, PlansTable } from "./_components/plans-content";
import type { PlanRow } from "./types";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  let plans: PlanRow[] = [];
  let error: string | null = null;
  try {
    const data = await adminFetch<ListResult<ApiPlanRow>>("/api/admin/plans");
    plans = (data.list ?? []).map((p) => ({ ...p }));
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <GemIcon className="size-5 text-muted-foreground" />
            套餐
          </h1>
          <p className="text-sm text-muted-foreground">包月订阅套餐（价格 / 额度均含积分展示）</p>
        </div>
        <CreatePlanDialog />
      </div>
      <Card>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <PlansTable plans={plans} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
