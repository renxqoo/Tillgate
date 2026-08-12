import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";

import {
  ApiError,
  adminFetch,
  type AdminBatchRow,
  type RedeemCodeRow as ApiRedeemCodeRow,
  type ListResult,
} from "@ai-gateway/api-client";
import { Button } from "@ai-gateway/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ai-gateway/ui/components/ui/card";

import { CodesTable } from "./_components/codes-table";
import type { RedeemCodeRow } from "../types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function BatchDetailPage({ params }: PageProps) {
  const { id } = await params;
  const batchId = Number(id);
  if (!Number.isFinite(batchId) || batchId <= 0) notFound();

  let batch: AdminBatchRow | null = null;
  let error: string | null = null;
  try {
    batch = await adminFetch<AdminBatchRow>(`/api/admin/redeem-batches/${batchId}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : "加载失败";
  }

  let codes: RedeemCodeRow[] = [];
  try {
    const data = await adminFetch<ListResult<ApiRedeemCodeRow>>(
      `/api/admin/redeem-batches/${batchId}/codes`,
    );
    codes = data.list ?? [];
  } catch {
    // codes 失败不阻塞
  }

  if (!batch) {
    return (
      <div className="flex flex-col gap-4">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href="/dashboard/redeem-batches">
            <ArrowLeftIcon /> 返回批次列表
          </Link>
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-destructive">{error ?? "批次不存在"}</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href="/dashboard/redeem-batches">
          <ArrowLeftIcon /> 返回批次列表
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">
            {batch.name}{" "}
            <span className="text-base font-normal text-muted-foreground">#{batch.id}</span>
          </CardTitle>
          <CardDescription>
            面值 ¥{batch.amount} · 共 {batch.total} 张 · 已用 {batch.usedCount} 张
            {batch.remark ? ` · ${batch.remark}` : ""}
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardContent className="px-0">
          <CodesTable codes={codes} />
        </CardContent>
      </Card>
    </div>
  );
}
