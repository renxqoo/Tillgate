'use client';

// 推荐关系表（DataTable 列定义 + 行内封禁/恢复动作）

import type { DataTableColumn } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { useTranslations } from 'next-intl';

import { fmtDateTime, formatMoney } from '@/lib/formatters';

import { RelationActions } from './relation-actions';
import type { ReferralRelationRow } from './relations-shared';

export type { ReferralRelationRow };

export function RelationsTable({ rows }: { rows: ReferralRelationRow[] }) {
  const t = useTranslations('referrals');
  const tc = useTranslations('common');
  const columns: DataTableColumn<ReferralRelationRow>[] = [
    {
      key: 'id',
      header: 'ID',
      render: (r) => <span className="text-xs tabular-nums text-muted-foreground">#{r.id}</span>,
    },
    {
      key: 'inviter',
      header: t('inviter'),
      render: (r) => (
        <span className="block max-w-56 truncate text-xs">
          {r.inviterEmail ?? t('userLabel', { id: r.inviterUserId })}
        </span>
      ),
    },
    {
      key: 'invitee',
      header: t('invitee'),
      render: (r) => (
        <span className="block max-w-56 truncate text-xs">
          {r.inviteeEmail ?? t('userLabel', { id: r.inviteeUserId })}
        </span>
      ),
    },
    {
      key: 'commissionTotal',
      header: t('commissionTotal'),
      render: (r) => (
        <span className="whitespace-nowrap text-xs tabular-nums">
          {formatMoney(r.commissionTotal, 2)}
        </span>
      ),
    },
    {
      key: 'status',
      header: tc('status'),
      render: (r) => (
        <span className={r.status === 1 ? 'text-xs text-destructive' : 'text-xs text-emerald-600'}>
          {r.status === 1 ? t('bannedShort') : tc('active')}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: t('boundAt'),
      render: (r) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {fmtDateTime(String(r.createdAt))}
        </span>
      ),
    },
    { key: 'actions', header: '', render: (r) => <RelationActions row={r} /> },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />;
}
