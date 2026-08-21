import type { AdminChannelRow } from "@ai-gateway/api-client";
import { fetchAdminList } from "@ai-gateway/api-client/list";
import { ListPage } from "@ai-gateway/ui/components/list-page";
import { firstParam, parseListSearchParams } from "@ai-gateway/ui/lib/list-query";
import { WalletIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { ChannelFundsClient } from "./_components/channel-funds-content";
import type { AdminChannelFundRow, ChannelOption } from "@ai-gateway/api-client/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export default async function ChannelFundsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const t = await getTranslations("channelFunds");
  const { q, page } = parseListSearchParams(sp);
  const channelIdRaw = firstParam(sp.channelId);
  const channelId = channelIdRaw ? Number(channelIdRaw) : undefined;
  const typeRaw = firstParam(sp.type);
  const type = typeRaw === "adjust" || typeRaw === "recharge" ? typeRaw : undefined;

  const { rows, total, error } = await fetchAdminList<AdminChannelFundRow>(
    "/v1/channel-funds",
    {
      page,
      pageSize: PAGE_SIZE,
      extra: { q, channelId: channelId ? String(channelId) : undefined, type },
    },
  );

  let channels: ChannelOption[] = [];
  try {
    const c = await fetchAdminList<AdminChannelRow>("/v1/channels", { pageSize: 100 });
    channels = c.rows.map((x) => ({ id: x.id, name: x.name }));
  } catch {
    // 渠道加载失败不阻塞
  }

  return (
    <ListPage
      title={t("title")}
      icon={<WalletIcon className="size-5 text-muted-foreground" />}
      description={t("description")}
      total={total}
      searchPlaceholder={t("searchPlaceholder")}
      q={q}
      searchParams={{ q, channelId: channelIdRaw, type }}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <ChannelFundsClient
        rows={rows}
        channels={channels}
        total={total}
        initialChannelId={channelId}
        initialType={type}
      />
    </ListPage>
  );
}