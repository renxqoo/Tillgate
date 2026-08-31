import type { getTranslations } from 'next-intl/server';
import type { AdminTransactionRow } from '@tillgate/api-client';

import type { DataTableColumn } from '@/components/data-table';
import { LocalTime } from '@/components/local-time';
import { fmtBalance } from '@/lib/formatters';
import { signedAmountTone } from '@/lib/money-tone';

/** 流水表列定义（cell 渲染器随列声明平铺；t/tc/locale 经参数传入） */
export function buildTxColumns(
  t: Awaited<ReturnType<typeof getTranslations<'users'>>>,
  tc: Awaited<ReturnType<typeof getTranslations<'common'>>>,
  locale: string,
): DataTableColumn<AdminTransactionRow>[] {
  return [
    {
      key: 'id',
      header: 'ID',
      sortable: true,
      headerClassName: 'w-20',
      render: (tr) => <span className="text-xs text-muted-foreground tabular-nums">#{tr.id}</span>,
    },
    {
      key: 'type',
      header: tc('type'),
      headerClassName: 'w-24',
      render: (tr) => <span className="text-xs">{tr.type}</span>,
    },
    {
      key: 'amount',
      header: t('amountChange'),
      sortable: true,
      align: 'right',
      render: (tr) => {
        const amount = Number(tr.amount);
        const tone = signedAmountTone(amount, locale);
        return (
          <span className={`text-right font-medium tabular-nums ${tone}`}>
            {amount >= 0 ? '+' : ''}
            {fmtBalance(tr.amount)}
          </span>
        );
      },
    },
    {
      key: 'balanceAfter',
      header: t('balanceAfter'),
      align: 'right',
      render: (tr) => (
        <span className="text-right tabular-nums">{fmtBalance(tr.balanceAfter)}</span>
      ),
    },
    {
      key: 'ref',
      header: t('reference'),
      render: (tr) => (
        <span className="text-xs text-muted-foreground">
          {tr.refType ? `${tr.refType}#${tr.refId ?? ''}` : '—'}
        </span>
      ),
    },
    {
      key: 'remark',
      header: tc('remark'),
      render: (tr) => (
        <span className="block max-w-xs truncate text-xs text-muted-foreground">
          {tr.remark ?? '—'}
        </span>
      ),
    },
    {
      key: 'createdBy',
      header: t('operator'),
      render: (tr) => <span className="text-xs text-muted-foreground">{tr.createdBy ?? '—'}</span>,
    },
    {
      key: 'createdAt',
      header: tc('time'),
      sortable: true,
      headerClassName: 'w-44',
      render: (tr) => <LocalTime iso={tr.createdAt} className="text-xs text-muted-foreground" />,
    },
  ];
}
