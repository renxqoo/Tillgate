import { UserPlusIcon } from 'lucide-react';

import { fetchAdminList } from '@ai-gateway/api-client/list';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { parseListSearchParams } from '@ai-gateway/ui/lib/list-query';
import { TabsList, TabsTrigger } from '@ai-gateway/ui/components/ui/tabs';
import Link from 'next/link';

import { PayoutsTable, RelationsTable, type PayoutRow, type ReferralRelationRow } from './_components/referrals-content';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;
const PAYOUT_KINDS = [
  { key: 'commission', label: '日结佣金' },
  { key: 'referral_signup', label: '邀请注册奖励' },
  { key: 'gift', label: '注册赠送' },
] as const;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReferralsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
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
        <TabsList className="flex-wrap">
          {PAYOUT_KINDS.map((k) => (
            <TabsTrigger key={k.key} value={k.key} data-state={payoutKind === k.key ? 'active' : 'inactive'} asChild>
              <Link href={`/dashboard/referrals?view=payouts&kind=${k.key}`}>{k.label}</Link>
            </TabsTrigger>
          ))}
        </TabsList>
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
        <TabsList className="flex-wrap">
          <TabsTrigger value="relations" data-state="active" asChild>
            <Link href="/dashboard/referrals">邀请关系</Link>
          </TabsTrigger>
          <TabsTrigger value="payouts" data-state="inactive" asChild>
            <Link href="/dashboard/referrals?view=payouts&kind=commission">返利流水</Link>
          </TabsTrigger>
        </TabsList>
        <RelationsTable rows={result.rows} />
      </div>
    );
  }

  return (
    <ListPage
      title="邀请管理"
      icon={<UserPlusIcon className="size-5 text-muted-foreground" />}
      description="邀请关系与返利流水（账本投影）；封禁 = 停止后续派奖，历史入账不动"
      total={total}
      searchPlaceholder={view === 'payouts' ? undefined : '搜索邀请人 / 被邀人邮箱'}
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
