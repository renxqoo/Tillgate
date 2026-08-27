'use client';

// 权限资源清单：DataTable 列定义 + 行操作（编辑/删除）+ 删除确认
// （弹窗在 node-edit-dialog / create-node-form，节点词表在 node-shared）

import type { PermissionNode } from '@tillgate/api-client';
import { Badge, ConfirmDialog } from '@tillgate/ui';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { DataTableColumn } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { StatusPill } from '@/components/status-pill';
import { useActionResult } from '@/components/action-toast';
import { deletePermissionAction } from '@/server/rbac-actions';
import { TYPE_ORDER } from './node-shared';
import { NodeRowActions } from './node-row-actions';

export { CreateNodeForm } from './create-node-form';

/** 资源清单（通用 DataTable;层级上下文经「父节点」列呈现,排序 目录→页面→按钮;分页/标题在页面层 ListPage） */
export function PermissionsContent({
  nodes,
  canUpdate,
  canDelete,
}: {
  nodes: PermissionNode[];
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations('permissions');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [deleting, setDeleting] = useState<PermissionNode | null>(null);

  const nameById = new Map(nodes.map((node) => [node.id, node.name]));
  const rows = nodes.toSorted(
    (a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.sortOrder - b.sortOrder || a.id - b.id,
  );

  const columns: DataTableColumn<PermissionNode>[] = [
    {
      key: 'name',
      header: tc('name'),
      render: (node) => <span className="font-medium">{node.name}</span>,
    },
    {
      key: 'type',
      header: t('nodeType'),
      render: (node) => <Badge variant="secondary">{t(`type_${node.type}`)}</Badge>,
    },
    {
      key: 'parent',
      header: t('parent'),
      render: (node) => (node.parentId != null ? (nameById.get(node.parentId) ?? '—') : '—'),
    },
    {
      key: 'code',
      header: t('code'),
      render: (node) => (
        <span className="font-mono text-xs text-muted-foreground">{node.code ?? '—'}</span>
      ),
    },
    {
      key: 'path',
      header: t('path'),
      render: (node) => (
        <span className="font-mono text-xs text-muted-foreground">{node.path ?? '—'}</span>
      ),
    },
    {
      key: 'source',
      header: t('sourceColumn'),
      render: (node) =>
        node.source === 'enforced' ? (
          <Badge>{t('enforced')}</Badge>
        ) : (
          <Badge variant="outline">{t('custom')}</Badge>
        ),
    },
    {
      key: 'status',
      header: tc('status'),
      render: (node) => (
        <StatusPill tone={node.status === 0 ? 'success' : 'neutral'}>
          {node.status === 0 ? tc('enabled') : tc('disabled')}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      header: tc('actions'),
      render: (node) => (
        <NodeRowActions
          node={node}
          nodes={nodes}
          canUpdate={canUpdate}
          canDelete={canDelete}
          onDelete={setDeleting}
        />
      ),
    },
  ];

  const onConfirm = async () => {
    if (deleting == null) return;
    const res = await deletePermissionAction(deleting.id);
    if (res.errorKey) toast.error(t(`errors.${res.errorKey}`));
    else notify(res, t('actionFailed'), t('deleted'));
    setDeleting(null);
  };

  return (
    <div className="space-y-3">
      <DataTable rowKey={(node) => node.id} rows={rows} columns={columns} empty={t('empty')} />
      <ConfirmDialog
        open={deleting != null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('deleteTitle', { name: deleting?.name ?? '' })}
        description={t('deleteDescription')}
        confirmLabel={tc('delete')}
        cancelLabel={tc('close')}
        tone="destructive"
        onConfirm={onConfirm}
      />
    </div>
  );
}
