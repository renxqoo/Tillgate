import { ApiError, adminFetch, type AdminChannelFundRow, type AdminChannelRow, type ListResult } from "@ai-gateway/api-client";
import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";
import { WalletIcon } from "lucide-react";

import { ChannelFundsClient } from "./_components/channel-funds-content";
import type { ChannelFundRow, ChannelOption } from "./types";

export const dynamic = "force-dynamic";

export default async function ChannelFundsPage({
  searchParams,
}: {
  searchParams: Promise<{ channelId?: string; type?: string }>;
}) {
  const sp = await searchParams;
  const channelId = sp.channelId ? Number(sp.channelId) : undefined;
  const type = sp.type === "adjust" || sp.type === "recharge" ? sp.type : undefined;

  let rows: ChannelFundRow[] = [];
  let channels: ChannelOption[] = [];
  let total = 0;
  let error: string | null = null;

  try {
    const qs = new URLSearchParams({ page: "1", page_size: "100" });
    if (channelId) qs.set("channelId", String(channelId));
    if (type) qs.set("type", type);
    const data = await adminFetch<ListResult<AdminChannelFundRow>>(
      `/api/admin/channel-funds?${qs.toString()}`,
    );
    rows = (data.list ?? []).map((r) => ({
      ...r,
      amount: r.amount,
      balanceAfter: r.balanceAfter,
    }));
    total = data.total ?? rows.length;
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  try {
    const c = await adminFetch<{ list: AdminChannelRow[] }>("/api/admin/channels");
    channels = (c.list ?? []).map((x) => ({ id: x.id, name: x.name }));
  } catch {
    // 渠道加载失败不阻塞
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <WalletIcon className="size-5 text-muted-foreground" />
          渠道资金
        </h1>
        <p className="text-sm text-muted-foreground">
          渠道进货额度入货与调账（含支付订单号、凭证截图，可追溯）
        </p>
      </div>

      <Card>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <ChannelFundsClient
              rows={rows}
              channels={channels}
              total={total}
              initialChannelId={channelId}
              initialType={type}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// 供别处 import 的类型（保持 page 可导出类型）
export type { ChannelFundRow };
