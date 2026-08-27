'use client';

import type { PermissionNode } from '@tillgate/api-client';
import { DropdownMenuItem, DropdownMenuSeparator, RowActions } from '@tillgate/ui';
import { useState } from 'react';
import { PencilIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { RoleFormDialog, type RoleRowWithGrants } from './role-form-dialog';

/** 行操作（统一 RowActions 三点菜单）:按按钮权限显隐(admins:update/delete);
 * 删除对全角色开放——唯一硬闸 = 挂载管理员(预检禁用+计数提示,后端 role_in_use 兜底) */
export function RoleRowActions({
  role,
  nodes,
  canUpdate,
  canDelete,
  onDelete,
}: {
  role: RoleRowWithGrants;
  nodes: PermissionNode[];
  canUpdate: boolean;
  canDelete: boolean;
  onDelete: (role: RoleRowWithGrants) => void;
}) {
  const t = useTranslations('roles');
  const tc = useTranslations('common');
  const [editOpen, setEditOpen] = useState(false);
  const inUse = role.adminCount > 0;

  if (!canUpdate && !canDelete) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <>
      {canUpdate && (
        <RoleFormDialog role={role} nodes={nodes} open={editOpen} onOpenChange={setEditOpen} />
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
            variant="destructive"
            disabled={inUse}
            title={inUse ? t('deleteBlockedHint', { count: role.adminCount }) : undefined}
            onClick={() => onDelete(role)}
          >
            <Trash2Icon className="size-4" />
            {tc('delete')}
          </DropdownMenuItem>
        )}
      </RowActions>
    </>
  );
}
