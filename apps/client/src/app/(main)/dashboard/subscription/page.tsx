import { GemIcon } from "lucide-react";

import {
  ApiError,
  apiFetch,
  type CurrentSubscription as ApiCurrentSubscription,
  type KeyRow as ApiKeyRow,
  type ListResult,
  type MeInfo,
  type Paginated,
  type PlanRow as ApiPlanRow,
} from "@ai-gateway/api-client";

import { SubscriptionContent } from "./_components/subscription-content";
import type { CurrentSubscription, PlanRow, SubKeyRow } from "./types";

export const dynamic = "force-dynamic";

export default async function SubscriptionPage() {
  let subscription: CurrentSubscription | null = null;
  let plans: PlanRow[] = [];
  let keys: SubKeyRow[] = [];
  let subError: string | null = null;
  let plansError: string | null = null;
  let isEnterprise = false;

  try {
    const me = await apiFetch<MeInfo>("/api/me");
    isEnterprise = me.isEnterprise === true;
  } catch {
    // 拿不到用户信息时按非企业处理（团队套餐会被隐藏）
    isEnterprise = false;
  }

  try {
    const data = await apiFetch<ApiCurrentSubscription | null>("/api/me/subscription");
    subscription = data ? { ...data } : null;
  } catch (e) {
    subError = e instanceof ApiError ? e.message : "加载失败";
  }

  try {
    const data = await apiFetch<ListResult<ApiPlanRow>>("/api/plans");
    // 个人用户只看到个人套餐（allowSeats=false）；企业用户只看到企业套餐（allowSeats=true，支持席位）
    plans = (data.list ?? [])
      .filter((p) => (isEnterprise ? p.allowSeats : !p.allowSeats))
      .map((p) => ({ ...p }));
  } catch (e) {
    plansError = e instanceof ApiError ? e.message : "加载失败";
  }

  try {
    const data = await apiFetch<Paginated<ApiKeyRow>>("/api/keys");
    keys = (data.list ?? []).map((k) => ({
      id: k.id,
      keyPreview: k.keyPreview,
      name: k.name,
      status: k.status,
      dailySpendLimit: k.dailySpendLimit,
    }));
  } catch {
    // Key 加载失败不阻塞订阅页
    keys = [];
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GemIcon className="size-5 text-muted-foreground" />
          套餐订阅
          {isEnterprise ? (
            <span className="inline-flex items-center rounded-full bg-violet-500/15 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300">
              企业账户
            </span>
          ) : null}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isEnterprise
            ? "企业账户可购买团队套餐（支持席位）"
            : "查看当前订阅，或购买包月套餐"}
        </p>
      </div>

      <SubscriptionContent
        subscription={subscription}
        plans={plans}
        subError={subError}
        plansError={plansError}
        keys={keys}
        seats={subscription?.quantity ?? 0}
      />
    </div>
  );
}
