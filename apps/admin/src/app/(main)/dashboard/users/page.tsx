import { UsersRound } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { ApiError, adminFetch, type AdminRateCardRow, type Paginated } from "@ai-gateway/api-client";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { firstParam, parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

import { UsersContent } from "./_components/users-content";
import { UsersExport } from "./_components/users-export";
import { UsersStatusFilter } from "./_components/users-status-filter";
import { UsersEnterpriseFilter } from "./_components/users-enterprise-filter";
import type { RateCardOption, AdminUserRow } from "@ai-gateway/api-client/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UsersPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations("users");
  const tc = await getTranslations("common");
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const status = firstParam(sp.status) ?? "all";
  const enterprise = firstParam(sp.enterprise) ?? "all";
  let rows: AdminUserRow[] = [];
  let total = 0;
  let error: string | null = null;
  let rateCards: RateCardOption[] = [];

  try {
    const query = new URLSearchParams({
      page: String(page),
      page_size: String(PAGE_SIZE),
      sort_by: sortBy ?? "createdAt",
      order,
    });
    if (q) query.set("q", q);
    if (status === "0" || status === "1") query.set("status", status);
    if (enterprise === "0" || enterprise === "1") query.set("enterprise", enterprise);
    const data = await adminFetch<Paginated<AdminUserRow>>(`/v1/users?${query.toString()}`);
    rows = data.rows ?? [];
    total = data.total ?? 0;
  } catch (e) {
    error = e instanceof ApiError ? e.message : tc("loadFailed");
  }

  try {
    const rc = await adminFetch<Paginated<AdminRateCardRow>>("/v1/rate-cards");
    rateCards = (rc.rows ?? rc.rows ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      coefficient: r.coefficient,
    }));
  } catch {
    // 费率卡加载失败不阻塞列表
  }

  return (
    <ListPage
      title={t("title")}
      icon={<UsersRound className="size-5 text-muted-foreground" />}
      description={t("description")}
      total={total}
      totalUnit={t("totalUnit")}
      searchPlaceholder={t("searchPlaceholder")}
      q={q}
      searchParams={{ q, status, enterprise, sort_by: sortBy, order: sortBy ? order : undefined }}
      filters={
        <>
          <UsersStatusFilter value={status} />
          <UsersEnterpriseFilter value={enterprise} />
        </>
      }
      actions={<UsersExport users={rows} />}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <UsersContent users={rows} rateCards={rateCards} />
    </ListPage>
  );
}
