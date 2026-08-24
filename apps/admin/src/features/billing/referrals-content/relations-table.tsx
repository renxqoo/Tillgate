'use client';

// 推荐关系表（DataTable 列定义 + 行内封禁/恢复动作）

import type { DataTableColumn } from '@/components/data-table';
import { DropdownMenuItem, RowActions } from '@tillgate/ui';
import { DataTable } from '@/components/data-table';
import { useTransition } from 'react';
import { BanIcon, CheckCircle2Icon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useActionResult } from '@/components/action-toast';
import { fmtDateTime, formatMoney } from '@/lib/formatters';

import { setRelationStatusAction } from '@/server/referrals-actions';

export interface ReferralRelationRow {
  id: number;
  inviterUserId: number;
  inviterEmail: string | null;
  inviteeUserId: number;
  inviteeEmail: string | null;
  status: number;
  createdAt: string;
  commissionTotal: string;
}

function RelationActions({ row }: { row: ReferralRelationRow }) {
  const t = useTranslations('referrals');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const banned = row.status === 1;
  let actionIcon = <BanIcon className="size-4" />;
  if (pending) actionIcon = <Loader2Icon className="size-4 animate-spin" />;
  else if (banned) actionIcon = <CheckCircle2Icon className="size-4" />;
  return (
    <RowActions label={tc('actions')}>
      <DropdownMenuItem
        variant={banned ? 'default' : 'destructive'}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            try {
              await setRelationStatusAction(row.id, banned ? 0 : 1);
              notify(
                {} as { error?: string },
                tc('actionFailed'),
                banned ? t('payoutResumed') : t('bannedToast'),
              );
            } catch (error) {
              notify({ error: error instanceof Error ? error.message : tc('actionFailed') });
            }
          })
        }
      >
        {actionIcon}
        {banned ? t('resume') : t('ban')}
      </DropdownMenuItem>
    </RowActions>
  );
}

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
