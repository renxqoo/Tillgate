import { NetworkIcon } from "lucide-react";

import { fetchAdminList } from "@ai-gateway/api-client/list";
import type { AdminProviderRow } from "@ai-gateway/api-client";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

import {
  ChannelsTable,
  CreateChannelDialog,
  ImportChannelsDialog,
} from "./_components/channels-content";
import type { AdminChannelRow, ProviderOption } from "@ai-gateway/api-client/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ChannelsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows: channels, total, error } = await fetchAdminList<AdminChannelRow>(
    "/api/admin/channels",
    { page, pageSize: PAGE_SIZE, sortBy, order, extra: { q } },
  );
  const providers: ProviderOption[] = [];
  try {
    const p = await fetchAdminList<AdminProviderRow>("/api/admin/providers", {
      page: 1,
      pageSize: 100,
    });
    for (const x of p.rows) {
      providers.push({
        id: x.id,
        name: x.name,
        baseUrl: x.baseUrl,
        protocol: x.protocol,
        status: x.status,
      });
    }
  } catch {
    // providers 失败不阻塞
  }

  return (
    <ListPage
      title="渠道"
      icon={<NetworkIcon className="size-5 text-muted-foreground" />}
      description="LLM 供应商渠道管理"
      total={total}
      searchPlaceholder="搜索渠道 / 供应商名"
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
      actions={
        <>
          <ImportChannelsDialog />
          <CreateChannelDialog providers={providers} />
        </>
      }
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <ChannelsTable channels={channels} providers={providers} />
    </ListPage>
  );
}
