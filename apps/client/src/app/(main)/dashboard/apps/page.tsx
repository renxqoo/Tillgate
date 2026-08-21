import { ShieldCheckIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { fetchUserList } from "@ai-gateway/api-client/list";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

import type { AppRow } from "@ai-gateway/api-client/types";
import { AppsTable, CreateAppDialog } from "./_components/apps-content";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AppsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations("apps");
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows, total, error } = await fetchUserList<AppRow>("/v1/apps", {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <ListPage
        title={t("title")}
        icon={<ShieldCheckIcon className="size-5 text-muted-foreground" />}
        description={t("description")}
        total={total}
        totalUnit={t("totalUnit")}
        searchPlaceholder={t("searchPlaceholder")}
        q={q}
        searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
        actions={<CreateAppDialog />}
        error={error}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <AppsTable apps={rows} />
      </ListPage>
    </div>
  );
}
