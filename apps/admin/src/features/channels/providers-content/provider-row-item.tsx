'use client';

// 渠道商表格行项：在册行的编辑/删除 + 回收站行的恢复（弹窗/确认件挂菜单外受控）

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  RowActions,
  TableCell,
  TableRow,
} from '@tillgate/ui';
import { StatusPill } from '@/components/status-pill';
import { useState } from 'react';
import { PencilIcon, RotateCcwIcon, ServerIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { AdminProviderRow } from '@tillgate/api-client';
import { fmtDateTime } from '@/lib/formatters';
import { ConfirmAction } from '@/components/confirm-action';
import { EditProviderDialog } from './edit-provider-dialog';

export function ProviderRowItem({
  provider,
  protocols,
  vendors,
}: {
  provider: AdminProviderRow;
  readonly protocols: ReadonlyArray<string>;
  readonly vendors: ReadonlyArray<string>;
}) {
  const t = useTranslations('providers');
  const tc = useTranslations('common');
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [undeleteOpen, setUndeleteOpen] = useState(false);
  // 回收站行（deletedAt 非空）：只读——仅「恢复记录」，其余动作不可达
  const deleted = provider.deletedAt != null;
  let status = <StatusPill tone="neutral" label={tc('disabled')} />;
  if (deleted) {
    status = (
      <div className="flex flex-col">
        <StatusPill tone="danger" label={t('deleted')} />
        <span className="mt-0.5 text-[10px] text-muted-foreground">
          {fmtDateTime(provider.deletedAt)}
        </span>
      </div>
    );
  } else if (provider.status === 0) {
    status = <StatusPill tone="success" label={tc('enabled')} />;
  }
  return (
    <TableRow className={deleted ? 'opacity-60' : undefined}>
      <TableCell>
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ServerIcon className="size-4" />
          </div>
          <span className="font-medium">{provider.name}</span>
        </div>
      </TableCell>
      <TableCell>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{provider.baseUrl}</code>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {provider.protocol}
        {provider.vendor ? (
          <span className="ml-1 rounded bg-muted px-1 py-0.5">{provider.vendor}</span>
        ) : null}
      </TableCell>
      <TableCell>{status}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {provider.updatedAt ? fmtDateTime(provider.updatedAt) : fmtDateTime(provider.createdAt)}
      </TableCell>
      <TableCell className="w-16 text-center">
        {deleted ? (
          <>
            <RowActions label={tc('actions')}>
              <DropdownMenuItem onClick={() => setUndeleteOpen(true)}>
                <RotateCcwIcon className="size-4" /> {t('undelete')}
              </DropdownMenuItem>
            </RowActions>
            {/* 弹窗挂在菜单外(受控 open):菜单点选关闭时会卸载整个 content,放里面会连弹窗一起卸掉 */}
            <ConfirmAction
              open={undeleteOpen}
              onOpenChange={setUndeleteOpen}
              confirm={t('undeleteConfirm', { name: provider.name })}
              action={async () =>
                (await import('@/server/providers-actions')).undeleteProviderAction(provider.id)
              }
              success={t('undeleteSuccess')}
              tone="default"
            />
          </>
        ) : (
          <>
            <RowActions label={tc('actions')}>
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <PencilIcon /> {tc('edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2Icon /> {tc('delete')}
              </DropdownMenuItem>
            </RowActions>
            <EditProviderDialog
              provider={provider}
              protocols={protocols}
              vendors={vendors}
              trigger={null}
              open={editOpen}
              onOpenChange={setEditOpen}
            />
            <ConfirmAction
              open={deleteOpen}
              onOpenChange={setDeleteOpen}
              confirm={t('deleteConfirm', { name: provider.name })}
              action={async () =>
                (await import('@/server/providers-actions')).deleteProviderAction(provider.id)
              }
              success={tc('deleted')}
            />
          </>
        )}
      </TableCell>
    </TableRow>
  );
}
