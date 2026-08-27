'use client';

import type { PermissionNode } from '@tillgate/api-client';
import { DropdownMenuItem, DropdownMenuSeparator, RowActions } from '@tillgate/ui';
import { useState } from 'react';
import { PencilIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { NodeEditDialog } from './node-edit-dialog';

/** 行操作（统一 RowActions 三点菜单）:按按钮权限显隐(admins:update/delete);
 * 删除全节点开放,子节点预检禁用（后端 permission_has_children 兜底） */
export function NodeRowActions({
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
