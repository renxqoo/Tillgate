'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { BanIcon, CheckCircle2Icon, Loader2Icon } from 'lucide-react';

import { Button } from '@ai-gateway/ui/components/ui/button';
import { useActionResult } from '@ai-gateway/ui/components/action-toast';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { fmtDateTime, formatMoney } from '@ai-gateway/api-client/formatters';

import { setRelationStatusAction } from '../actions';

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
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const banned = row.status === 1;
  return (
    <Button
      size="sm"
      variant={banned ? 'outline' : 'destructive'}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await setRelationStatusAction(row.id, banned ? 0 : 1);
            notify({} as { error?: string }, '操作失败', banned ? '已恢复派奖' : '已封禁（停止后续佣金，历史入账不动）');
          } catch (e) {
            notify({ error: e instanceof Error ? e.message : '操作失败' });
          }
        })
      }
    >
      {pending ? <Loader2Icon className="size-4 animate-spin" /> : banned ? <CheckCircle2Icon className="size-4" /> : <BanIcon className="size-4" />}
      {banned ? '恢复' : '封禁'}
    </Button>
  );
}

export function RelationsTable({ rows }: { rows: ReferralRelationRow[] }) {
  const columns: DataTableColumn<ReferralRelationRow>[] = [
    { key: 'id', header: 'ID', render: (r) => <span className="text-xs tabular-nums text-muted-foreground">#{r.id}</span> },
    { key: 'inviter', header: '邀请人', render: (r) => <span className="block max-w-56 truncate text-xs">{r.inviterEmail ?? `用户#${r.inviterUserId}`}</span> },
    { key: 'invitee', header: '被邀人', render: (r) => <span className="block max-w-56 truncate text-xs">{r.inviteeEmail ?? `用户#${r.inviteeUserId}`}</span> },
    { key: 'commissionTotal', header: '累计佣金', render: (r) => <span className="whitespace-nowrap text-xs tabular-nums">{formatMoney(r.commissionTotal, 2)}</span> },
    { key: 'status', header: '状态', render: (r) => <span className={r.status === 1 ? 'text-xs text-destructive' : 'text-xs text-emerald-600'}>{r.status === 1 ? '已封禁' : '有效'}</span> },
    { key: 'createdAt', header: '绑定时间', render: (r) => <span className="whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(String(r.createdAt))}</span> },
    { key: 'actions', header: '', render: (r) => <RelationActions row={r} /> },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />;
}

export function PayoutsTable({ rows }: { rows: PayoutRow[] }) {
  const columns: DataTableColumn<PayoutRow>[] = [
    { key: 'id', header: 'ID', render: (r) => <span className="text-xs tabular-nums text-muted-foreground">#{r.id}</span> },
    { key: 'kind', header: '类型', render: (r) => <span className="whitespace-nowrap text-xs">{r.kind}</span> },
    { key: 'refId', header: '幂等锚', render: (r) => <span className="block max-w-64 truncate text-xs font-mono" title={r.refId}>{r.refId}</span> },
    { key: 'memo', header: '备注', render: (r) => <span className="block max-w-48 truncate text-xs text-muted-foreground" title={r.memo ?? undefined}>{r.memo ?? '—'}</span> },
    { key: 'createdAt', header: '时间', render: (r) => <span className="whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(String(r.createdAt))}</span> },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />;
}

/** 视图/类型切换（select 形态——Radix Tabs 需容器且与 SSR 导航不搭，链接筛选是项目既有模式） */
export function ReferralsViewSelect({ view, kind }: { view: string; kind: string }) {
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
        aria-label="视图"
      >
        <option value="relations">邀请关系</option>
        <option value="payouts">返利流水</option>
      </select>
      {view === 'payouts' ? (
        <select
          onChange={(e) => change('kind', e.target.value)}
          defaultValue={kind}
          className="h-9 rounded-md border border-input bg-transparent px-3 shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="流水类型"
        >
          <option value="commission">日结佣金</option>
          <option value="referral_signup">邀请注册奖励</option>
          <option value="gift">注册赠送</option>
        </select>
      ) : null}
    </div>
  );
}
