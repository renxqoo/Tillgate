import { GiftIcon } from 'lucide-react';

import { fmtBalance, fmtDateTime, type RedeemHistoryItem } from '@ai-gateway/api-client';
import { fetchUserList } from '@ai-gateway/api-client/list';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { parseListSearchParams } from '@ai-gateway/ui/lib/list-query';
import { getTranslations } from 'next-intl/server';

import Link from 'next/link';

import { RedeemForm } from './_components/redeem-form';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RedeemPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations('redeem');
  const { page, sortBy, order } = parseListSearchParams(sp);
  const {
    rows: history,
    total,
    error,
  } = await fetchUserList<RedeemHistoryItem>('/v1/redeem/history', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
  });

  const columns: DataTableColumn<RedeemHistoryItem>[] = [
    {
      key: 'amount',
      header: t('colValue'),
      align: 'right',
      render: (r) => (
        <span className="text-right font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
          +¥{fmtBalance(r.amount)}
        </span>
      ),
    },
    {
      key: 'batchName',
      header: t('colBatch'),
      render: (r) => <span className="text-sm text-muted-foreground">{r.batchName ?? '—'}</span>,
    },
    {
      key: 'usedAt',
      header: t('colRedeemedAt'),
      sortable: true,
      render: (r) => <span className="text-xs text-muted-foreground">{fmtDateTime(r.usedAt)}</span>,
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
        total={total}
        error={error}
        page={page}
        pageSize={PAGE_SIZE}
        searchParams={{ sort_by: sortBy, order: sortBy ? order : undefined }}
        aboveList={<RedeemForm />}
      >
        {history.length > 0 ? (
          <DataTable
            columns={columns}
            rows={history}
            rowKey={(r) => r.id}
            sort={{ sortBy, order }}
            searchParams={{ sort_by: sortBy, order: sortBy ? order : undefined }}
            empty={t('empty')}
          />
        ) : null}
      </ListPage>
    </div>
  );
}
