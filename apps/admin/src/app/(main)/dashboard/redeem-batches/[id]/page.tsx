import { requirePermission } from '@/server/get-admin';
import { Button, Card, CardContent } from '@tokenlens/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tokenlens/api-client';
import type { AdminBatchRow, RedeemCodeRow as ApiRedeemCodeRow } from '@tokenlens/api-client';
import { formatMoney } from '@/lib/formatters';
import { adminApi } from '@/server/admin-api';
import { fetchAdminList } from '@/server/admin-list';
import { parseListSearchParams } from '@/lib/list-query';
import { ListPage } from '@/components/list-page';

import { CodesTable } from '@/features/billing/redeem-codes-table';
import type { RedeemCodeRow } from '@tokenlens/api-client';

const PAGE_SIZE = 20;

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BatchDetailPage({ params, searchParams }: PageProps) {
  await requirePermission('funds:read');
  const { id } = await params;
  const t = await getTranslations('redeemBatches');
  const tc = await getTranslations('common');
  const batchId = Number(id);
  if (!Number.isFinite(batchId) || batchId <= 0) notFound();

  let batch: AdminBatchRow | null = null;
  let error: string | null = null;
  try {
    batch = await adminApi().get<AdminBatchRow>(`/v1/redeem-batches/${batchId}`);
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
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          render={
            <Link href="/dashboard/redeem-batches">
              <ArrowLeftIcon /> {t('back')}
            </Link>
          }
        />
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
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        render={
          <Link href="/dashboard/redeem-batches">
            <ArrowLeftIcon /> {t('back')}
          </Link>
        }
      />

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
