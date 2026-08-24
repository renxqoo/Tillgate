'use client';

// 派发记录表（DataTable 列定义，只读）

import type { DataTableColumn } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { useTranslations } from 'next-intl';

import { fmtDateTime } from '@/lib/formatters';

export interface PayoutRow {
  id: number;
  kind: string;
  refType: string;
  refId: string;
  memo: string | null;
  createdAt: string;
}

export function PayoutsTable({ rows }: { rows: PayoutRow[] }) {
  const t = useTranslations('referrals');
  const tc = useTranslations('common');
  const columns: DataTableColumn<PayoutRow>[] = [
    {
      key: 'id',
      header: 'ID',
      render: (r) => <span className="text-xs tabular-nums text-muted-foreground">#{r.id}</span>,
    },
    {
      key: 'kind',
      header: tc('type'),
      render: (r) => <span className="whitespace-nowrap text-xs">{r.kind}</span>,
    },
    {
      key: 'refId',
      header: t('idempotencyKey'),
      render: (r) => (
        <span className="block max-w-64 truncate text-xs font-mono" title={r.refId}>
          {r.refId}
        </span>
      ),
    },
    {
      key: 'memo',
      header: tc('remark'),
      render: (r) => (
        <span
          className="block max-w-48 truncate text-xs text-muted-foreground"
          title={r.memo ?? undefined}
        >
          {r.memo ?? '—'}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: tc('time'),
      render: (r) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {fmtDateTime(String(r.createdAt))}
        </span>
      ),
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />;
}
