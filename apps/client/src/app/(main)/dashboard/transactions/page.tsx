import { CoinsIcon } from 'lucide-react';

import { fmtBalance, fmtDateTime, formatMoney, type TransactionRow } from '@ai-gateway/api-client';
import { fetchUserList } from '@ai-gateway/api-client/list';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { ListPage } from '@ai-gateway/ui/components/list-page';
import { parseListSearchParams } from "@ai-gateway/ui/lib/list-query";

export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = {
  redeem: '充值',
  gift: '赠送',
  consume: '消费',
  refund: '退款',
  adjust: '调账',
};

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  // v2 statement 行（legId/transactionKind/memo）→ 页面 TransactionRow 形状
  const statement = await fetchUserList<{
    legId: number;
    transactionKind: string;
    amount: string;
    balanceAfter: string;
    refType: string;
    refId: string;
    memo: string | null;
    createdAt: string;
  }>('/api/wallet/statement', {
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
      header: '时间',
      sortable: true,
      render: (t) => <span className="text-xs text-muted-foreground">{fmtDateTime(t.createdAt)}</span>,
    },
    { key: 'type', header: '类型', render: (t) => TYPE_LABEL[t.type] ?? t.type },
    {
      key: 'remark',
      header: '说明',
      render: (t) => <span className="text-sm text-muted-foreground">{t.remark ?? '—'}</span>,
    },
    {
      key: 'amount',
      header: '金额（元）',
      sortable: true,
      align: 'right',
      render: (t) => (
        <span
          className={
            'text-right font-medium tabular-nums ' +
            (t.amount.startsWith('-') ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400')
          }
        >
          {t.amount.startsWith('-') ? formatMoney(t.amount) : `+${formatMoney(t.amount)}`}
        </span>
      ),
    },
    {
      key: 'balanceAfter',
      header: '已结算余额后',
      align: 'right',
      render: (t) => <span className="text-right tabular-nums text-muted-foreground">{fmtBalance(t.balanceAfter)}</span>,
    },
  ];

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <ListPage
        title="账单流水"
        icon={<CoinsIcon className="size-5 text-muted-foreground" />}
        description="账户余额变动记录"
        total={total}
        searchPlaceholder="搜索备注 / 关联 / 类型"
        q={q}
        searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
        error={error}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(t) => t.id}
          sort={{ sortBy, order }}
          searchParams={{ q }}
          empty="暂无流水"
        />
      </ListPage>
    </div>
  );
}
