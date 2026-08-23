import { UserPlusIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fetchAdminList, type ListFetchOptions } from '@/server/admin-list';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

import {
  PayoutsTable,
  ReferralsViewSelect,
  RelationsTable,
  type PayoutRow,
  type ReferralRelationRow,
} from '@/features/billing/referrals-content';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;
interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReferralsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations('referrals');
  const { q, page } = parseListSearchParams(sp);
  const view = (Array.isArray(sp.view) ? sp.view[0] : sp.view) ?? 'relations';
  const payoutKind = (Array.isArray(sp.kind) ? sp.kind[0] : sp.kind) ?? 'commission';
  const isPayouts = view === 'payouts';

  async function load<T>(
    path: string,
    extra: ListFetchOptions['extra'],
    Table: React.ComponentType<{ rows: T[] }>,
  ) {
    const { rows, total, error } = await fetchAdminList<T>(path, {
      page,
      pageSize: PAGE_SIZE,
      extra,
    });
    return { total, error, table: <Table rows={rows} /> };
  }

  const { total, error, table } = isPayouts
    ? await load<PayoutRow>('/v1/referrals/payouts', { kind: payoutKind }, PayoutsTable)
    : await load<ReferralRelationRow>('/v1/referrals/relations', { q }, RelationsTable);

  return (
    <ListPage
      title={t('title')}
      icon={<UserPlusIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      searchPlaceholder={isPayouts ? undefined : t('searchPlaceholder')}
      q={isPayouts ? undefined : q}
      searchParams={isPayouts ? { view: 'payouts', kind: payoutKind } : undefined}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <div className="space-y-3">
        <div className="ml-4 mt-4"><ReferralsViewSelect view={view} kind={payoutKind} /></div>
        {table}
      </div>
    </ListPage>
  );
}
