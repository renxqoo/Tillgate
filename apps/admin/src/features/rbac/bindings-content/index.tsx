'use client';

// 接口绑定清单：DataTable 列定义 + 行操作（编辑/解绑）+ 解绑确认
// （创建弹窗在 create-binding-form，编辑弹窗在 edit-binding-dialog，方法词表在 binding-shared）

import type { EndpointBindingRow, PermissionNode } from '@tillgate/api-client';
import {
  Badge,
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  RowActions,
} from '@tillgate/ui';
import { useState } from 'react';
import { PencilIcon, UnlinkIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { DataTableColumn } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { useActionResult } from '@/components/action-toast';
import { deleteBindingAction } from '@/server/binding-actions';
import { EditBindingDialog } from './edit-binding-dialog';

export { CreateBindingForm } from './create-binding-form';

/** 接口绑定清单（DataTable:method/path/权限码/来源/操作;分页/标题在页面层 ListPage） */
export function BindingsContent({
  bindings,
  nodes,
  canUpdate,
  canDelete,
}: {
  bindings: EndpointBindingRow[];
  nodes: PermissionNode[];
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations('endpoints');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [editing, setEditing] = useState<EndpointBindingRow | null>(null);
  const [deleting, setDeleting] = useState<EndpointBindingRow | null>(null);

  const codeById = new Map(nodes.map((node) => [node.id, node.code ?? node.name]));
  const rows = bindings.toSorted(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );

  const columns: DataTableColumn<EndpointBindingRow>[] = [
    {
      key: 'method',
      header: t('method'),
      render: (row) => <Badge variant="secondary">{row.method}</Badge>,
    },
    {
      key: 'path',
      header: t('path'),
      render: (row) => <span className="font-mono text-xs">{row.path}</span>,
    },
    {
      key: 'code',
      header: t('permission'),
      render: (row) => (
        <span className="font-mono text-xs text-muted-foreground">
          {codeById.get(row.permissionId) ?? `#${row.permissionId}`}
        </span>
      ),
    },
    {
      key: 'source',
      header: t('sourceColumn'),
      render: (row) => (
        <Badge variant={row.source === 'enforced' ? 'default' : 'outline'}>
          {row.source === 'enforced' ? t('enforced') : t('custom')}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: tc('actions'),
      render: (row) => (
        <>
          {canUpdate && editing?.id === row.id && (
            <EditBindingDialog
              binding={row}
              nodes={nodes}
              open={editing != null}
              onOpenChange={(open) => !open && setEditing(null)}
            />
          )}
          {canUpdate || canDelete ? (
            <RowActions label={tc('actions')}>
              {canUpdate && (
                <DropdownMenuItem onClick={() => setEditing(row)}>
                  <PencilIcon className="size-4" />
                  {tc('edit')}
                </DropdownMenuItem>
              )}
              {canUpdate && canDelete && <DropdownMenuSeparator />}
              {canDelete && (
                <DropdownMenuItem onClick={() => setDeleting(row)}>
                  <UnlinkIcon className="size-4" />
                  {t('unbind')}
                </DropdownMenuItem>
              )}
            </RowActions>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </>
      ),
    },
  ];

  const onConfirm = async () => {
    if (deleting == null) return;
    const res = await deleteBindingAction(deleting.id);
    if (res.errorKey) toast.error(t(`errors.${res.errorKey}`));
    else notify(res, t('actionFailed'), t('unbound'));
    setDeleting(null);
  };

  return (
    <div className="space-y-3">
      <DataTable rowKey={(row) => row.id} rows={rows} columns={columns} empty={t('empty')} />
      <ConfirmDialog
        open={deleting != null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('unbindTitle', { method: deleting?.method ?? '', path: deleting?.path ?? '' })}
        description={t('unbindDescription')}
        confirmLabel={t('unbind')}
        cancelLabel={tc('close')}
        tone="destructive"
        onConfirm={onConfirm}
      />
    </div>
  );
}
