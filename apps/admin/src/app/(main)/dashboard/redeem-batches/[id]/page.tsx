import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';

import {
  ApiError,
  adminFetch,
  formatMoney,
  type AdminBatchRow,
  type RedeemCodeRow as ApiRedeemCodeRow,
} from '@ai-gateway/api-client';
import { fetchAdminList } from '@ai-gateway/api-client/list';
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";
import { Button } from '@ai-gateway/ui/components/ui/button';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { Card, CardContent } from '@ai-gateway/ui/components/ui/card';

import { CodesTable } from './_components/codes-table';
import type { RedeemCodeRow } from '@ai-gateway/api-client/types';

const PAGE_SIZE = 20;

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BatchDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const batchId = Number(id);
  if (!Number.isFinite(batchId) || batchId <= 0) notFound();

  let batch: AdminBatchRow | null = null;
  let error: string | null = null;
  try {
    batch = await adminFetch<AdminBatchRow>(`/api/admin/redeem-batches/${batchId}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : '加载失败';
  }

  const sp = await searchParams;
  const { page, sortBy, order } = parseListSearchParams(sp);
  const codesResult = await fetchAdminList<ApiRedeemCodeRow>(
    `/api/admin/redeem-batches/${batchId}/codes`,
    { page, pageSize: PAGE_SIZE, sortBy, order },
  );
  const codes: RedeemCodeRow[] = codesResult.rows;
  const codesTotal = codesResult.total;
  const codesError = codesResult.error;

  if (!batch) {
    return (
      <div className="flex flex-col gap-4">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href="/dashboard/redeem-batches">
            <ArrowLeftIcon /> 返回批次列表
          </Link>
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {error ?? '批次不存在'}
          </CardContent>
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

      <ListPage
        title={`${batch.name} #${batch.id}`}
        description={`面值 ¥${formatMoney(batch.amount)} · 共 ${batch.total} 张 · 已用 ${batch.usedCount} 张${batch.remark ? ` · ${batch.remark}` : ''}`}
        total={codesTotal}
        totalUnit="张"
        error={codesError}
        page={page}
        pageSize={PAGE_SIZE}
        searchParams={{ sort_by: sortBy, order: sortBy ? order : undefined }}
      >
        <CodesTable codes={codes} />
      </ListPage>
    </div>
  );
}
