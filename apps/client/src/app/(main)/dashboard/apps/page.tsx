import { ShieldCheckIcon } from "lucide-react";

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
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows, total, error } = await fetchUserList<AppRow>("/api/apps", {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <ListPage
        title="应用"
        icon={<ShieldCheckIcon className="size-5 text-muted-foreground" />}
        description="OAuth 风格 client_id / secret"
        total={total}
        totalUnit="个"
        searchPlaceholder="搜索应用名 / 描述"
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
