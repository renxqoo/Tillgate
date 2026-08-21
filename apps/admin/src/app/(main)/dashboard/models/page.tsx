import { CpuIcon } from "lucide-react";

import { fetchAdminList } from "@ai-gateway/api-client/list";
import type { AdminChannelRow } from "@ai-gateway/api-client";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

import { CreateModelDialog, ModelsTable } from "./_components/models-content";
import type { ChannelOption, AdminModelRow } from "@ai-gateway/api-client/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ModelsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows: models, total, error } = await fetchAdminList<AdminModelRow>(
    "/v1/models",
    { page, pageSize: PAGE_SIZE, sortBy, order, extra: { q } },
  );
  let channels: ChannelOption[] = [];
  try {
    const c = await fetchAdminList<AdminChannelRow>("/v1/channels", {
      page: 1,
      pageSize: 100,
    });
    channels = c.rows.map((x) => ({ id: x.id, name: x.name, providerName: x.providerName }));
  } catch {
    // channels 失败不阻塞
  }

  return (
    <ListPage
      title="模型映射"
      icon={<CpuIcon className="size-5 text-muted-foreground" />}
      description="外部模型名 → 上游真实模型 + 单价"
      total={total}
      searchPlaceholder="搜索外部名 / 真实模型"
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
      actions={<CreateModelDialog />}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <ModelsTable models={models} channels={channels} />
    </ListPage>
  );
}
