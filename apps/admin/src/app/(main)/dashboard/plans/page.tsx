import { GemIcon } from "lucide-react";

import { fetchAdminList } from "@ai-gateway/api-client/list";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

import { CreatePlanDialog, PlansTable } from "./_components/plans-content";
import type { PlanRow } from "@ai-gateway/api-client/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PlansPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows, total, error } = await fetchAdminList<PlanRow>("/v1/plans", {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });

  return (
    <ListPage
      title="套餐"
      icon={<GemIcon className="size-5 text-muted-foreground" />}
      description="包月订阅与加油包套餐（价格 / 额度均含积分展示）"
      total={total}
      searchPlaceholder="搜索套餐名"
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
      actions={<CreatePlanDialog />}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <PlansTable plans={rows} />
    </ListPage>
  );
}
