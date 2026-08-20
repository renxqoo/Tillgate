'use client';

import { useTransition } from 'react';
import { BanIcon, CheckCircle2Icon, Loader2Icon } from 'lucide-react';

import { Button } from '@ai-gateway/ui/components/ui/button';
import { useActionResult } from '@ai-gateway/ui/components/action-toast';
import { DataTable, type DataTableColumn } from '@ai-gateway/ui/components/data-table';
import { fmtDateTime, formatMoney } from '@ai-gateway/api-client';

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
    { key: 'inviter', header: '邀请人', render: (r) => <span className="text-xs">{r.inviterEmail ?? `用户#${r.inviterUserId}`}</span> },
    { key: 'invitee', header: '被邀人', render: (r) => <span className="text-xs">{r.inviteeEmail ?? `用户#${r.inviteeUserId}`}</span> },
    { key: 'commissionTotal', header: '累计佣金', render: (r) => <span className="text-xs tabular-nums">{formatMoney(r.commissionTotal)}</span> },
    { key: 'status', header: '状态', render: (r) => <span className={r.status === 1 ? 'text-xs text-destructive' : 'text-xs text-emerald-600'}>{r.status === 1 ? '已封禁' : '有效'}</span> },
    { key: 'createdAt', header: '绑定时间', render: (r) => <span className="text-xs text-muted-foreground">{fmtDateTime(String(r.createdAt))}</span> },
    { key: 'actions', header: '', render: (r) => <RelationActions row={r} /> },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />;
}

export function PayoutsTable({ rows }: { rows: PayoutRow[] }) {
  const columns: DataTableColumn<PayoutRow>[] = [
    { key: 'id', header: 'ID', render: (r) => <span className="text-xs tabular-nums text-muted-foreground">#{r.id}</span> },
    { key: 'kind', header: '类型', render: (r) => <span className="text-xs">{r.kind}</span> },
    { key: 'refId', header: '幂等锚', render: (r) => <span className="text-xs font-mono">{r.refId}</span> },
    { key: 'memo', header: '备注', render: (r) => <span className="text-xs text-muted-foreground">{r.memo ?? '—'}</span> },
    { key: 'createdAt', header: '时间', render: (r) => <span className="text-xs text-muted-foreground">{fmtDateTime(String(r.createdAt))}</span> },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />;
}
