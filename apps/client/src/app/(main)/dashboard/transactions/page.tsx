import { CoinsIcon } from 'lucide-react';

import { fmtBalance, fmtDateTime, formatMoney, type TransactionRow } from '@ai-gateway/api-client';
import { fetchUserList } from '@ai-gateway/api-client/list';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { signedAmountTone } from '@ai-gateway/ui/lib/money-tone';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";
import { getLocale, getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

/** 流水类型 → transactions.typeXxx 目录键；未知类型原样回显 */
const TYPE_KEYS: Record<string, string> = {
  redeem: 'typeRedeem',
  gift: 'typeGift',
  consume: 'typeConsume',
  refund: 'typeRefund',
  adjust: 'typeAdjust',
};

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const locale = await getLocale();
  const t = await getTranslations('transactions');
  const tCommon = await getTranslations('common');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  // statement 行（legId/transactionKind/memo）→ 页面 TransactionRow 形状
  const statement = await fetchUserList<{
    legId: number;
    transactionKind: string;
    amount: string;
    balanceAfter: string;
    refType: string;
    refId: string;
    memo: string | null;
    createdAt: string;
  }>('/v1/wallet/statement', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });
  const rows: TransactionRow[] = statement.rows.map((r) => ({
    id: r.legId,
    userId: 0,
    type: r.transactionKind,
    amount: r.amount,
    balanceBefore: '',
    balanceAfter: r.balanceAfter,
    refType: r.refType,
    refId: r.refId,
    remark: r.memo,
    createdAt: r.createdAt,
  }));
  const { total, error } = statement;

  const columns: DataTableColumn<TransactionRow>[] = [
    {
      key: 'createdAt',
      header: tCommon('time'),
      sortable: true,
      render: (row) => <span className="text-xs text-muted-foreground">{fmtDateTime(row.createdAt)}</span>,
    },
    {
      key: 'type',
      header: t('colType'),
      render: (row) => {
        const key = TYPE_KEYS[row.type];
        return key ? t(key) : row.type;
      },
    },
    {
      key: 'remark',
      header: t('colRemark'),
      render: (row) => <span className="text-sm text-muted-foreground">{row.remark ?? '—'}</span>,
    },
    {
      key: 'amount',
      header: t('colAmount'),
      sortable: true,
      align: 'right',
      render: (row) => (
        <span
          className={
            'text-right font-medium tabular-nums ' + signedAmountTone(row.amount, locale)
          }
        >
          {row.amount.startsWith('-') ? formatMoney(row.amount) : `+${formatMoney(row.amount)}`}
        </span>
      ),
    },
    {
      key: 'balanceAfter',
      header: t('colBalanceAfter'),
      align: 'right',
      render: (row) => <span className="text-right tabular-nums text-muted-foreground">{fmtBalance(row.balanceAfter)}</span>,
    },
  ];

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <ListPage
        title={t('title')}
        icon={<CoinsIcon className="size-5 text-muted-foreground" />}
        description={t('description')}
        total={total}
        searchPlaceholder={t('searchPlaceholder')}
        q={q}
        searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
        error={error}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          sort={{ sortBy, order }}
          searchParams={{ q }}
          empty={t('empty')}
        />
      </ListPage>
    </div>
  );
}
