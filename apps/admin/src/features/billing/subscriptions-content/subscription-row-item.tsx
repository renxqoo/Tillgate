'use client';

// 订阅表格行项：金额/额度展示 + 续订/取消/变更套餐（变更弹窗在 change-subscription-dialog）

import { StatusPill, defineStatusMeta } from '@/components/status-pill';
import {
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  RowActions,
  TableCell,
  TableRow,
} from '@tillgate/ui';
import { useState } from 'react';

import { ArrowUpRightIcon, Loader2Icon, RefreshCwIcon, XCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { fmtDateTime, formatMoney, formatPoints } from '@/lib/formatters';

import type { AdminSubscriptionRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import { ChangeSubscriptionDialog } from './change-subscription-dialog';
import type { PlanOption } from './subscriptions-shared';

// 状态 tone 映射留模块级；label 是 subscriptions 命名空间的 i18n key，渲染处用 t 解析
const STATUS_META = defineStatusMeta({
  0: { label: 'statusActive', tone: 'success' },
  1: { label: 'statusExpired', tone: 'warning' },
  2: { label: 'statusCancelled', tone: 'neutral' },
});

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

export function SubscriptionRowItem({
  row,
  plans,
}: {
  row: AdminSubscriptionRow;
  plans: ReadonlyArray<PlanOption>;
}) {
  const t = useTranslations('subscriptions');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [pending, setPending] = useState<'renew' | 'cancel' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const meta = STATUS_META.get(row.status);

  async function run(action: 'renew' | 'cancel') {
    setPending(action);
    const mod = await import('@/server/subscriptions-actions');
    const res =
      action === 'renew'
        ? await mod.renewSubscriptionAction(row.id)
        : await mod.cancelSubscriptionAction(row.id);
    setPending(null);
    notify(
      res,
      action === 'renew' ? t('renewFailed') : t('cancelFailed'),
      action === 'renew' ? t('renewed') : t('cancelled'),
    );
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
      <TableCell className="tabular-nums">×{row.quantity}</TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={row.price} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        <div>{fmtDateTime(row.startAt)}</div>
        <div className="text-muted-foreground/70">
          {t('until', { date: fmtDateTime(row.endAt) })}
        </div>
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
        <StatusPill tone={meta.tone} label={t(meta.label)} />
      </TableCell>
      <TableCell className="w-16 text-center">
        {/* 行操作走全站统一的 RowActions 菜单项范式（勿在菜单面板里放独立 Button 竖排） */}
        <RowActions label={tc('actions')}>
          {row.status === 0 ? (
            <>
              <DropdownMenuItem onClick={() => setChangeOpen(true)}>
                <ArrowUpRightIcon className="size-4" /> {t('change')}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={pending !== null} onClick={() => run('renew')}>
                {pending === 'renew' ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-4" />
                )}
                {t('renew')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={pending !== null}
                onClick={() => setConfirmOpen(true)}
              >
                {pending === 'cancel' ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <XCircleIcon className="size-4" />
                )}
                {tUi('cancel')}
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem disabled>—</DropdownMenuItem>
          )}
        </RowActions>
        <ChangeSubscriptionDialog
          row={row}
          plans={plans}
          open={changeOpen}
          onOpenChange={setChangeOpen}
        />
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={tUi('confirmTitle')}
          description={t('cancelConfirm')}
          confirmLabel={tUi('confirm')}
          cancelLabel={tUi('cancel')}
          tone="destructive"
          onConfirm={() => run('cancel')}
          onError={(e) => toast.error(e instanceof Error ? e.message : String(e))}
        />
      </TableCell>
    </TableRow>
  );
}
