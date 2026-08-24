import { requirePermission } from '@/server/get-admin';
import { TicketIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fetchAdminList } from '@/server/admin-list';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

import { BatchesTable, GenerateBatchDialog } from '@/features/billing/redeem-batches-content';
import type { AdminBatchRow } from '@tillgate/api-client';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RedeemBatchesPage({ searchParams }: PageProps) {
  await requirePermission('funds:read');
  const sp = await searchParams;
  const t = await getTranslations('redeemBatches');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows, total, error } = await fetchAdminList<AdminBatchRow>('/v1/redeem-batches', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });

  return (
    <ListPage
      title={t('title')}
      icon={<TicketIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
      actions={<GenerateBatchDialog />}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <BatchesTable batches={rows} />
    </ListPage>
  );
}
