'use client';

// 费率卡表格行项：查看用户/编辑/删除（弹窗与确认件挂菜单外受控）

import {
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  RowActions,
  TableCell,
  TableRow,
} from '@tillgate/ui';
import { StatusPill } from '@/components/status-pill';
import { useState } from 'react';
import Link from 'next/link';

import { EyeIcon, Loader2Icon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { AdminRateCardRow } from '@tillgate/api-client';
import { fmtDateTime } from '@/lib/formatters';
import { EditRateCardDialog } from './edit-rate-card-dialog';

export function RateCardRowItem({ card }: { card: AdminRateCardRow }) {
  const t = useTranslations('rateCards');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const [deleting, setDeleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function runDelete() {
    setDeleting(true);
    const { deleteRateCardAction } = await import('@/server/rate-cards-actions');
    const res = await deleteRateCardAction(card.id);
    setDeleting(false);
    if (res.error) toast.error(String(res.error));
    else toast.success(tc('deleted'));
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link href={`/dashboard/rate-cards/${card.id}`} className="hover:underline">
          {card.name}
        </Link>
      </TableCell>
      <TableCell className="text-right tabular-nums">×{card.coefficient}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{card.description ?? '—'}</TableCell>
      <TableCell>
        {card.status === 0 ? (
          <StatusPill tone="success" label={tc('enabled')} />
        ) : (
          <StatusPill tone="neutral" label={tc('disabled')} />
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{fmtDateTime(card.updatedAt)}</TableCell>
      <TableCell className="w-16 text-center">
        {/* 行操作走全站统一的 RowActions 菜单项范式（勿在菜单面板里放独立 Button 竖排） */}
        <RowActions label={tc('actions')}>
          <DropdownMenuItem render={<Link href={`/dashboard/rate-cards/${card.id}`} />}>
            <EyeIcon className="size-4" /> {t('viewUsers')}
          </DropdownMenuItem>
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
        <EditRateCardDialog card={card} open={editOpen} onOpenChange={setEditOpen} />
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={tc('delete')}
          description={t('deleteConfirm', { name: card.name })}
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
