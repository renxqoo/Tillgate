'use client';

import type { PermissionNode } from '@tillgate/api-client';
import {
  Badge,
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  RowActions,
} from '@tillgate/ui';
import { useState } from 'react';
import { PencilIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { DataTableColumn } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { NodeEditDialog } from './permissions-dialogs';
import { StatusPill } from '@/components/status-pill';
import { useActionResult } from '@/components/action-toast';
import { deletePermissionAction } from '@/server/rbac-actions';

type NodeType = 'group' | 'page' | 'button';

const TYPE_ORDER: Record<NodeType, number> = { group: 0, page: 1, button: 2 };

/** 行操作（统一 RowActions 三点菜单）:按按钮权限显隐(admins:update/delete);
 * 删除全节点开放,子节点预检禁用（后端 permission_has_children 兜底） */
function NodeRowActions({
  node,
  nodes,
  canUpdate,
  canDelete,
  onDelete,
}: {
  node: PermissionNode;
  nodes: PermissionNode[];
  canUpdate: boolean;
  canDelete: boolean;
  onDelete: (node: PermissionNode) => void;
}) {
  const t = useTranslations('permissions');
  const tc = useTranslations('common');
  const [editOpen, setEditOpen] = useState(false);
  const hasChildren = nodes.some((n) => n.parentId === node.id);

  if (!canUpdate && !canDelete) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <>
      {canUpdate && (
        <NodeEditDialog node={node} nodes={nodes} open={editOpen} onOpenChange={setEditOpen} />
      )}
      <RowActions label={tc('actions')}>
        {canUpdate && (
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            <PencilIcon className="size-4" />
            {tc('edit')}
          </DropdownMenuItem>
        )}
        {canUpdate && canDelete && <DropdownMenuSeparator />}
        {canDelete && (
          <DropdownMenuItem
            disabled={hasChildren}
            title={hasChildren ? t('deleteBlockedHint') : undefined}
            onClick={() => onDelete(node)}
          >
            <Trash2Icon className="size-4" />
            {tc('delete')}
          </DropdownMenuItem>
        )}
      </RowActions>
    </>
  );
}

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
        onConfirm={async () => {
          if (deleting == null) return;
          const res = await deletePermissionAction(deleting.id);
          if (res.errorKey) toast.error(t(`errors.${res.errorKey}`));
          else notify(res, t('actionFailed'), t('deleted'));
          setDeleting(null);
        }}
      />
    </div>
  );
}
