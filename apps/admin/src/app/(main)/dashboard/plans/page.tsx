import { GemIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";

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
  const t = await getTranslations("plans");
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
      title={t("title")}
      icon={<GemIcon className="size-5 text-muted-foreground" />}
      description={t("description")}
      total={total}
      searchPlaceholder={t("searchPlaceholder")}
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
