import { requirePermission } from '@/server/get-admin';
import { BanknoteIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fetchAdminList } from '@/server/admin-list';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

import { CreateRateCardDialog, RateCardsTable } from '@/features/billing/rate-cards-content';
import type { AdminRateCardRow } from '@tillgate/api-client';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RateCardsPage({ searchParams }: PageProps) {
  await requirePermission('catalog:read');
  const sp = await searchParams;
  const t = await getTranslations('rateCards');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows, total, error } = await fetchAdminList<AdminRateCardRow>('/v1/rate-cards', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });

  return (
    <ListPage
      title={t('title')}
      icon={<BanknoteIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
      actions={<CreateRateCardDialog />}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <RateCardsTable cards={rows} />
    </ListPage>
  );
}
