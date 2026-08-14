import { GemIcon } from "lucide-react";

import {
  ApiError,
  apiFetch,
  type CurrentSubscription as ApiCurrentSubscription,
  type ListResult,
  type PlanRow as ApiPlanRow,
} from "@ai-gateway/api-client";

import { SubscriptionContent } from "./_components/subscription-content";
import type { CurrentSubscription, PlanRow } from "./types";

export const dynamic = "force-dynamic";

export default async function SubscriptionPage() {
  let subscription: CurrentSubscription | null = null;
  let plans: PlanRow[] = [];
  let subError: string | null = null;
  let plansError: string | null = null;

  try {
    const data = await apiFetch<ApiCurrentSubscription | null>("/api/me/subscription");
    subscription = data ? { ...data } : null;
  } catch (e) {
    subError = e instanceof ApiError ? e.message : "加载失败";
  }

  try {
    const data = await apiFetch<ListResult<ApiPlanRow>>("/api/plans");
    plans = (data.list ?? []).map((p) => ({ ...p }));
  } catch (e) {
    plansError = e instanceof ApiError ? e.message : "加载失败";
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GemIcon className="size-5 text-muted-foreground" />
          套餐订阅
        </h1>
        <p className="text-sm text-muted-foreground">查看当前订阅，或购买包月套餐</p>
      </div>

      <SubscriptionContent
        subscription={subscription}
        plans={plans}
        subError={subError}
        plansError={plansError}
      />
    </div>
  );
}
