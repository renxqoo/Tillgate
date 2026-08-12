import { BanknoteIcon } from "lucide-react";

import {
  ApiError,
  adminFetch,
  type AdminRateCardRow,
  type ListResult,
} from "@ai-gateway/api-client";
import { Card, CardContent } from "@ai-gateway/ui/components/ui/card";

import { CreateRateCardDialog, RateCardsTable } from "./_components/rate-cards-content";
import type { RateCardRow } from "./types";

export const dynamic = "force-dynamic";

export default async function RateCardsPage() {
  let cards: RateCardRow[] = [];
  let error: string | null = null;
  try {
    const data = await adminFetch<ListResult<AdminRateCardRow>>("/api/admin/rate-cards");
    cards = data.list ?? [];
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <BanknoteIcon className="size-5 text-muted-foreground" />
            费率卡
          </h1>
          <p className="text-sm text-muted-foreground">基于官方价格 ×系数</p>
        </div>
        <CreateRateCardDialog />
      </div>
      <Card>
        <CardContent className="px-0">
          {error ? (
            <p className="p-8 text-center text-sm text-destructive">{error}</p>
          ) : (
            <RateCardsTable cards={cards} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
