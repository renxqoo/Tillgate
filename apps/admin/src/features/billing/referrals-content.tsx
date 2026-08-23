'use client';

import type { DataTableColumn } from '@/components/data-table';
import { DropdownMenuItem, RowActions } from '@tokenlens/ui';
import { DataTable } from '@/components/data-table';
import { useRouter, useSearchParams } from 'next/navigation';
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

export interface PayoutRow {
  id: number;
  kind: string;
  refType: string;
  refId: string;
  memo: string | null;
  createdAt: string;
}

function RelationActions({ row }: { row: ReferralRelationRow }) {
  const t = useTranslations('referrals');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const banned = row.status === 1;
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
            } catch (e) {
              notify({ error: e instanceof Error ? e.message : tc('actionFailed') });
            }
          })
        }
      >
        {pending ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : banned ? (
          <CheckCircle2Icon className="size-4" />
        ) : (
          <BanIcon className="size-4" />
        )}
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

/** 视图/类型切换（select 形态——Radix Tabs 需容器且与 SSR 导航不搭，链接筛选是项目既有模式） */
export function ReferralsViewSelect({ view, kind }: { view: string; kind: string }) {
  const t = useTranslations('referrals');
  const router = useRouter();
  const sp = useSearchParams();

  function change(key: 'view' | 'kind', value: string) {
    const next = new URLSearchParams(sp.toString());
    if (key === 'view') {
      next.set('view', value);
      if (value !== 'payouts') next.delete('kind');
      else if (!next.get('kind')) next.set('kind', 'commission');
    } else {
      next.set('view', 'payouts');
      next.set('kind', value);
    }
    next.delete('page');
    router.push(`/dashboard/referrals?${next.toString()}`);
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <select
        onChange={(e) => change('view', e.target.value)}
        defaultValue={view}
        className="h-9 rounded-md border border-input bg-transparent px-3 shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={t('view')}
      >
        <option value="relations">{t('relations')}</option>
        <option value="payouts">{t('payouts')}</option>
      </select>
      {view === 'payouts' ? (
        <select
          onChange={(e) => change('kind', e.target.value)}
          defaultValue={kind}
          className="h-9 rounded-md border border-input bg-transparent px-3 shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={t('payoutKind')}
        >
          <option value="commission">{t('dailyCommission')}</option>
          <option value="referral_signup">{t('referralSignup')}</option>
          <option value="gift">{t('signupGift')}</option>
        </select>
      ) : null}
    </div>
  );
}
