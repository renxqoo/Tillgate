import { UserPlusIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fetchAdminList } from '@/server/admin-list';
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

  let content: React.ReactNode;
  let total = 0;
  let error: string | null = null;

  if (view === 'payouts') {
    const result = await fetchAdminList<PayoutRow>(`/v1/referrals/payouts`, {
      page,
      pageSize: PAGE_SIZE,
      extra: { kind: payoutKind },
    });
    total = result.total;
    error = result.error;
    content = (
      <div className="space-y-3">
        <ReferralsViewSelect view={view} kind={payoutKind} />
        <PayoutsTable rows={result.rows} />
      </div>
    );
  } else {
    const result = await fetchAdminList<ReferralRelationRow>(`/v1/referrals/relations`, {
      page,
      pageSize: PAGE_SIZE,
      extra: { q },
    });
    total = result.total;
    error = result.error;
    content = (
      <div className="space-y-3">
        <ReferralsViewSelect view={view} kind={payoutKind} />
        <RelationsTable rows={result.rows} />
      </div>
    );
  }

  return (
    <ListPage
      title={t('title')}
      icon={<UserPlusIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      searchPlaceholder={view === 'payouts' ? undefined : t('searchPlaceholder')}
      q={view === 'payouts' ? undefined : q}
      searchParams={view === 'payouts' ? { view: 'payouts', kind: payoutKind } : undefined}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      {content}
    </ListPage>
  );
}
