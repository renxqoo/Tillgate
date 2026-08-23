import { GiftIcon } from 'lucide-react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { ApiError, type RedeemHistoryItem, type RedeemHistoryPage } from '@tokenlens/api-client';
import { Button, DataTable, type DataTableColumn } from '@tokenlens/ui';

import { formatDateTime, formatMoney } from '@/features/shared/format';
import { signedAmountTone } from '@/features/shared/money-tone';
import { ListPage } from '@/features/shared/list-page';
import { RedeemForm } from '@/features/wallet/redeem-form';
import { listHref, parseListSearchParams } from '@/server/list-query';
import { createClientApi } from '@/server/api';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RedeemPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const locale = await getLocale();
  const t = await getTranslations('redeem');
  const { page } = parseListSearchParams(sp);
  const api = createClientApi();
  await requireMe(api);

  let history: RedeemHistoryItem[] = [];
  let error: string | null = null;
  let hasMore = false;
  try {
    // 信封只 rows 无 total（G3 族）——「加载更多」按满页判断续读
    const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    const result = await api.get<RedeemHistoryPage>(`/v1/redeem/history?${qs.toString()}`);
    history = result.rows;
    hasMore = result.rows.length === PAGE_SIZE;
  } catch (e) {
    error = e instanceof ApiError ? e.message : null;
  }

  const columns: DataTableColumn<RedeemHistoryItem>[] = [
    {
      key: 'amount',
      header: t('colValue'),
      align: 'right',
      cell: (r) => (
        <span
          className={'text-right font-medium tabular-nums ' + signedAmountTone(r.amount, locale)}
        >
          +{formatMoney(r.amount, locale)}
        </span>
      ),
    },
    {
      key: 'batchName',
      header: t('colBatch'),
      cell: (r) => <span className="text-sm text-muted-foreground">{r.batchName ?? '—'}</span>,
    },
    {
      key: 'usedAt',
      header: t('colRedeemedAt'),
      cell: (r) => (
        <span className="text-xs text-muted-foreground">{formatDateTime(r.usedAt, locale)}</span>
      ),
    },
  ];

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <ListPage
        title={t('title')}
        icon={<GiftIcon className="size-5 text-muted-foreground" />}
        description={t.rich('description', {
          link: (chunks) => (
            <Link href="/dashboard/transactions" className="underline hover:text-foreground">
              {chunks}
            </Link>
          ),
        })}
        total={undefined}
        error={error}
        searchParams={{ page: page > 1 ? String(page) : undefined }}
        aboveList={<RedeemForm />}
      >
        {history.length > 0 ? (
          <>
            <DataTable
              columns={columns}
              rows={history}
              rowKey={(r) => r.codeId}
              empty={t('empty')}
            />
            {hasMore && !error ? (
              <div className="flex justify-center p-4">
                <Button
                  variant="outline"
                  size="sm"
                  render={<a href={listHref(sp, { page: page + 1 })} />}
                >
                  {t('loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </ListPage>
    </div>
  );
}
