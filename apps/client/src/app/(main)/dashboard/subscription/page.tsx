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
import { getTranslations } from "next-intl/server";

import { SubscriptionContent } from "./_components/subscription-content";
import { StatusPill } from "@ai-gateway/ui/components/status-pill";

export const dynamic = "force-dynamic";

export default async function SubscriptionPage() {
  const t = await getTranslations("subscription");
  let subscription: CurrentSubscription | null = null;
  let plans: PlanRow[] = [];
  let orgs: OrgRow[] = [];
  let subError: string | null = null;
  let plansError: string | null = null;
  let isEnterprise = false;

  try {
    const me = await apiFetch<MeInfo>("/v1/me");
    isEnterprise = me.isEnterprise === true;
  } catch {
    // 拿不到用户信息时按非企业处理（团队套餐会被隐藏）
    isEnterprise = false;
  }

  try {
    const subResult = await apiFetch<{ rows?: CurrentSubscription[] }>("/v1/subscriptions");
    const data: CurrentSubscription | null = subResult.rows?.[0] ?? null;
    subscription = data;
  } catch (e) {
    subError = e instanceof ApiError ? e.message : t("loadFailed");
  }

  try {
    const data = await apiFetch<Paginated<PlanRow>>("/v1/plans?sort_by=sortOrder&order=asc&page_size=100");
    // 个人用户只看到个人套餐（allowSeats=false）；企业用户只看到企业套餐（allowSeats=true，支持席位）
    plans = (data.rows ?? []).filter((p) => (isEnterprise ? p.allowSeats : !p.allowSeats));
  } catch (e) {
    plansError = e instanceof ApiError ? e.message : t("loadFailed");
  }

  try {
    const data = await apiFetch<Paginated<OrgRow>>("/v1/orgs");
    // 只展示有有效套餐的组织；无套餐组织在 /dashboard/orgs 管理，不在此展示。
    orgs = (data.rows ?? []).filter((o) => o.subscriptionId != null);
  } catch {
    orgs = [];
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GemIcon className="size-5 text-muted-foreground" />
          {t("title")}
          {isEnterprise ? (
            <StatusPill tone="accent" label={t("enterpriseBadge")} />
          ) : null}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isEnterprise ? t("descEnterprise") : t("descPersonal")}
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
