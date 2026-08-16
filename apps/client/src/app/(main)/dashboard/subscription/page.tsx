import { GemIcon } from "lucide-react";

import {
  ApiError,
  apiFetch,
  type CurrentSubscription,
  type Paginated,
  type MeInfo,
  type OrgRow,
  type PlanRow,
} from "@ai-gateway/api-client";

import { SubscriptionContent } from "./_components/subscription-content";
import { StatusPill } from "@ai-gateway/ui/components/status-pill";

export const dynamic = "force-dynamic";

export default async function SubscriptionPage() {
  let subscription: CurrentSubscription | null = null;
  let plans: PlanRow[] = [];
  let orgs: OrgRow[] = [];
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
    const data = await apiFetch<CurrentSubscription | null>("/api/me/subscription");
    subscription = data;
  } catch (e) {
    subError = e instanceof ApiError ? e.message : "加载失败";
  }

  try {
    const data = await apiFetch<Paginated<PlanRow>>("/api/plans?sort_by=sortOrder&order=asc&page_size=100");
    // 个人用户只看到个人套餐（allowSeats=false）；企业用户只看到企业套餐（allowSeats=true，支持席位）
    plans = (data.list ?? []).filter((p) => (isEnterprise ? p.allowSeats : !p.allowSeats));
  } catch (e) {
    plansError = e instanceof ApiError ? e.message : "加载失败";
  }

  try {
    const data = await apiFetch<Paginated<OrgRow>>("/api/orgs");
    // 只展示有有效套餐的组织；无套餐组织在 /dashboard/orgs 管理，不在此展示。
    orgs = (data.list ?? []).filter((o) => o.subscriptionId != null);
  } catch {
    orgs = [];
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GemIcon className="size-5 text-muted-foreground" />
          套餐订阅
          {isEnterprise ? (
            <StatusPill tone="accent" label="企业账户" />
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
        orgs={orgs}
      />
    </div>
  );
}
