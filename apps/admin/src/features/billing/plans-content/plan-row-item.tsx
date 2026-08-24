'use client';

// 套餐表格行项：类型/席位徽章 + 发放加油包/编辑/删除（弹窗与确认件挂菜单外受控）

import { StatusPill } from '@/components/status-pill';
import {
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  RowActions,
  TableCell,
  TableRow,
} from '@tillgate/ui';
import { useState } from 'react';

import { GiftIcon, Loader2Icon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { formatMoney, formatPoints } from '@/lib/formatters';

import type { PlanRow } from '@tillgate/api-client';
import { EditPlanDialog } from './edit-plan-dialog';
import { GrantPackDialog } from './grant-pack-dialog';

/** 钱 + 积分并列展示（纯展示层，积分 = 元 × 100）。 */
function MoneyPoints({ value }: { value: string }) {
  const tUi = useTranslations('ui');
  return (
    <span className="tabular-nums">
      <span className="font-medium">¥{formatMoney(value)}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">
        {formatPoints(value)} {tUi('points')}
      </span>
    </span>
  );
}

function StatusBadge({ status }: { status: number }) {
  const t = useTranslations('plans');
  if (status === 0) {
    return <StatusPill tone="success" label={t('listed')} />;
  }
  return <StatusPill tone="neutral" label={t('unlisted')} />;
}

function KindBadge({ kind }: { kind: PlanRow['kind'] }) {
  const t = useTranslations('plans');
  if (kind === 'pack') {
    return <StatusPill tone="accent" label={t('pack')} />;
  }
  return <StatusPill tone="info" label={t('subscription')} />;
}

export function PlanRowItem({
  plan,
  fmtPeriod,
  tUi,
}: {
  plan: PlanRow;
  fmtPeriod: (days: number) => string;
  tUi: ReturnType<typeof useTranslations<'ui'>>;
}) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const [deleting, setDeleting] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  let seatStatus = <StatusPill tone="neutral" label={t('personal')} />;
  if (plan.kind === 'pack') seatStatus = <span className="text-xs text-muted-foreground">—</span>;
  else if (plan.allowSeats) seatStatus = <StatusPill tone="accent" label={t('team')} />;

  async function runDelete() {
    setDeleting(true);
    const { deletePlanAction } = await import('@/server/plans-actions');
    const res = await deletePlanAction(plan.id);
    setDeleting(false);
    if (res.error) toast.error(String(res.error));
    else toast.success(tc('deleted'));
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{plan.name}</TableCell>
      <TableCell>
        <KindBadge kind={plan.kind} />
      </TableCell>
      <TableCell className="tabular-nums">{plan.sortOrder ?? '—'}</TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={plan.price} />
      </TableCell>
      <TableCell>{plan.kind === 'pack' ? '—' : fmtPeriod(plan.periodDays)}</TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={plan.quotaAmount} />
      </TableCell>
      <TableCell>{seatStatus}</TableCell>
      <TableCell>
        <StatusBadge status={plan.status} />
      </TableCell>
      <TableCell className="w-16 text-center">
        {/* 行操作走全站统一的 RowActions 菜单项范式（勿在菜单面板里放独立 Button 竖排） */}
        <RowActions label={tc('actions')}>
          {plan.kind === 'pack' ? (
            <DropdownMenuItem onClick={() => setGrantOpen(true)}>
              <GiftIcon className="size-4" /> {t('grant')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            <PencilIcon className="size-4" /> {tc('edit')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirmOpen(true)}>
            {deleting ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <Trash2Icon className="size-4" />
            )}
            {tc('delete')}
          </DropdownMenuItem>
        </RowActions>
        {plan.kind === 'pack' ? (
          <GrantPackDialog plan={plan} tUi={tUi} open={grantOpen} onOpenChange={setGrantOpen} />
        ) : null}
        <EditPlanDialog plan={plan} tUi={tUi} open={editOpen} onOpenChange={setEditOpen} />
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={tc('delete')}
          description={t('deleteConfirm', { name: plan.name })}
          confirmLabel={tc('delete')}
          cancelLabel={tUi('cancel')}
          tone="destructive"
          onConfirm={runDelete}
          onError={(e) => toast.error(e instanceof Error ? e.message : String(e))}
        />
      </TableCell>
    </TableRow>
  );
}
