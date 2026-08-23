import { CoinsIcon } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { ApiError, type StatementPage, type StatementRow } from '@tokenlens/api-client';
import { Button, DataTable, type DataTableColumn } from '@tokenlens/ui';

import { formatDateTime, formatMoney } from '@/features/shared/format';
import { signedAmountTone } from '@/features/shared/money-tone';
import { ListPage } from '@/features/shared/list-page';
import { firstParam, listHref } from '@/server/list-query';
import { createClientApi } from '@/server/api';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

/** 流水类型 → transactions.typeXxx 目录键；未知类型原样回显 */
const TYPE_KEYS: Record<string, string> = {
  redeem: 'typeRedeem',
  gift: 'typeGift',
  consume: 'typeConsume',
  refund: 'typeRefund',
  adjust: 'typeAdjust',
};

/** 游标页大小（满页时 nextCursor=尾腿 legId，续读锚） */
const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * 钱包流水（游标分页——D-A：v1 页码条改「加载更多」，URL 状态锚 ?before=）。
 */
export default async function TransactionsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const locale = await getLocale();
  const t = await getTranslations('transactions');
  const tCommon = await getTranslations('common');
  const before = firstParam(sp.before);
  const beforeLegId = before != null ? Number(before) : undefined;
  const api = createClientApi();
  await requireMe(api);

  let rows: StatementRow[] = [];
  let nextCursor: string | undefined;
  let error: string | null = null;
  try {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (beforeLegId != null && Number.isFinite(beforeLegId) && beforeLegId > 0) {
      query.set('beforeLegId', String(beforeLegId));
    }
    const page = await api.get<StatementPage>(`/v1/wallet/statement?${query.toString()}`);
    rows = page.rows;
    nextCursor = page.nextCursor;
  } catch (e) {
    error = e instanceof ApiError ? e.message : t('loadFailed');
  }

  const columns: DataTableColumn<StatementRow>[] = [
    {
      key: 'createdAt',
      header: tCommon('time'),
      cell: (row) => (
        <span className="text-xs text-muted-foreground">
          {formatDateTime(row.createdAt, locale)}
        </span>
      ),
    },
    {
      key: 'type',
      header: t('colType'),
      cell: (row) => {
        const key = TYPE_KEYS[row.transactionKind];
        return key ? t(key) : row.transactionKind;
      },
    },
    {
      key: 'remark',
      header: t('colRemark'),
      cell: (row) => <span className="text-sm text-muted-foreground">{row.memo ?? '—'}</span>,
    },
    {
      key: 'amount',
      header: t('colAmount'),
      align: 'right',
      cell: (row) => (
        <span
          className={'text-right font-medium tabular-nums ' + signedAmountTone(row.amount, locale)}
        >
          {row.amount.startsWith('-')
            ? formatMoney(row.amount, locale)
            : `+${formatMoney(row.amount, locale)}`}
        </span>
      ),
    },
    {
      key: 'balanceAfter',
      header: t('colBalanceAfter'),
      align: 'right',
      cell: (row) => (
        <span className="text-right tabular-nums text-muted-foreground">
          {formatMoney(row.balanceAfter, locale)}
        </span>
      ),
    },
  ];

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <ListPage
        title={t('title')}
        icon={<CoinsIcon className="size-5 text-muted-foreground" />}
        description={t('description')}
        searchParams={{ before }}
        error={error}
      >
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.legId} empty={t('empty')} />
        {nextCursor != null && !error ? (
          <div className="flex justify-center p-4">
            <Button
              variant="outline"
              size="sm"
              render={<a href={listHref(sp, { before: nextCursor })} />}
            >
              {t('loadMore')}
            </Button>
          </div>
        ) : null}
      </ListPage>
    </div>
  );
}
