import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

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
  const t = await getTranslations('redeemBatches');
  const tc = await getTranslations('common');
  const batchId = Number(id);
  if (!Number.isFinite(batchId) || batchId <= 0) notFound();

  let batch: AdminBatchRow | null = null;
  let error: string | null = null;
  try {
    batch = await adminFetch<AdminBatchRow>(`/v1/redeem-batches/${batchId}`);
  } catch (e) {
    error = e instanceof ApiError ? e.message : tc('loadFailed');
  }

  const sp = await searchParams;
  const { page, sortBy, order } = parseListSearchParams(sp);
  const codesResult = await fetchAdminList<ApiRedeemCodeRow>(
    `/v1/redeem-batches/${batchId}/codes`,
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
            <ArrowLeftIcon /> {t('back')}
          </Link>
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {error ?? t('notFound')}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href="/dashboard/redeem-batches">
          <ArrowLeftIcon /> {t('back')}
        </Link>
      </Button>

      <ListPage
        title={`${batch.name} #${batch.id}`}
        description={t('detailDescription', {
          amount: formatMoney(batch.amount),
          total: batch.total,
          used: batch.usedCount,
          remark: batch.remark ? t('remarkPart', { remark: batch.remark }) : '',
        })}
        total={codesTotal}
        totalUnit={t('unit')}
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
