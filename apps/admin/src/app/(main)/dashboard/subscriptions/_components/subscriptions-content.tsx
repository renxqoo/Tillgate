'use client';

import { useState } from 'react';

import { Loader2Icon, RefreshCwIcon, XCircleIcon } from 'lucide-react';
import { toast } from 'sonner';

import { fmtDateTime, formatMoney, formatPoints } from '@ai-gateway/api-client/formatters';
import { Button } from '@ai-gateway/ui/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';

import type { SubscriptionRow } from '../types';

const STATUS_META: Record<number, { label: string; cls: string }> = {
  0: { label: '有效', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  1: { label: '到期', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  2: { label: '取消', cls: 'bg-muted text-muted-foreground' },
};

function statusMeta(status: number): { label: string; cls: string } {
  return (
    STATUS_META[status] ?? { label: '未知', cls: 'bg-muted text-muted-foreground' }
  );
}

/** 钱 + 积分并列展示（纯展示层，积分 = 元 × 100）。 */
function MoneyPoints({ value }: { value: string }) {
  return (
    <span className="tabular-nums">
      <span className="font-medium">¥{formatMoney(value)}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">{formatPoints(value)} 积分</span>
    </span>
  );
}

export function SubscriptionsTable({ rows }: { readonly rows: ReadonlyArray<SubscriptionRow> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>用户</TableHead>
          <TableHead>套餐</TableHead>
          <TableHead>有效期</TableHead>
          <TableHead className="text-right">额度</TableHead>
          <TableHead className="text-right">已用</TableHead>
          <TableHead className="text-right">剩余</TableHead>
          <TableHead className="w-20">状态</TableHead>
          <TableHead className="w-32 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
              暂无订阅
            </TableCell>
          </TableRow>
        ) : (
          rows.map((r) => <SubscriptionRowItem key={r.id} row={r} />)
        )}
      </TableBody>
    </Table>
  );
}

function SubscriptionRowItem({ row }: { row: SubscriptionRow }) {
  const [pending, setPending] = useState<'renew' | 'cancel' | null>(null);
  const meta = statusMeta(row.status);

  async function run(action: 'renew' | 'cancel') {
    setPending(action);
    const mod = await import('../actions');
    const res =
      action === 'renew'
        ? await mod.renewSubscriptionAction(row.id)
        : await mod.cancelSubscriptionAction(row.id);
    setPending(null);
    if (res.error) toast.error(action === 'renew' ? '续费失败' : '取消失败', { description: res.error });
    else toast.success(action === 'renew' ? '已续费' : '已取消');
  }

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{row.userSubject}</div>
        {row.userDisplayName ? (
          <div className="text-xs text-muted-foreground">{row.userDisplayName}</div>
        ) : null}
      </TableCell>
      <TableCell className="font-medium">{row.planName}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        <div>{fmtDateTime(row.startAt)}</div>
        <div className="text-muted-foreground/70">至 {fmtDateTime(row.endAt)}</div>
      </TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={row.quotaAmount} />
      </TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={row.usedAmount} />
      </TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={row.remainingAmount} />
      </TableCell>
      <TableCell>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}
        >
          {meta.label}
        </span>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {row.status === 0 ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => run('renew')}
              >
                {pending === 'renew' ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                续费
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => {
                  if (!confirm('确定取消该订阅？剩余额度作废，不退款。')) return;
                  void run('cancel');
                }}
                className="text-destructive hover:text-destructive"
              >
                {pending === 'cancel' ? <Loader2Icon className="animate-spin" /> : <XCircleIcon />}
                取消
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
