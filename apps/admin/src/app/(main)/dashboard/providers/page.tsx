import { ServerIcon } from "lucide-react";

import { SUPPORTED_PROTOCOLS, vendorProfileNames } from "@ai-gateway/ai";

import { fetchAdminList } from "@ai-gateway/api-client/list";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

import { CreateProviderDialog, ProvidersTable } from "./_components/providers-content";
import type { AdminProviderRow } from "@ai-gateway/api-client/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ProvidersPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows, total, error } = await fetchAdminList<AdminProviderRow>("/v1/providers", {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });

  return (
    <ListPage
      title="供应商"
      icon={<ServerIcon className="size-5 text-muted-foreground" />}
      description="LLM 供应商入口（baseUrl + 协议）"
      total={total}
      searchPlaceholder="搜索名称 / baseUrl"
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
      actions={<CreateProviderDialog protocols={SUPPORTED_PROTOCOLS} vendors={vendorProfileNames()} />}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <ProvidersTable providers={rows} protocols={SUPPORTED_PROTOCOLS} vendors={vendorProfileNames()} />
    </ListPage>
  );
}
