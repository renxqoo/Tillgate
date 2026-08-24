'use client';

// 角色清单：DataTable 列定义 + 行操作（编辑/删除）+ 删除确认
// （共享表单弹窗在 role-form-dialog，授权树在 grant-tree）

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
import { useActionResult } from '@/components/action-toast';
import { deleteRoleAction } from '@/server/rbac-actions';
import { RoleFormDialog, type RoleRowWithGrants } from './role-form-dialog';

export { RoleCreateForm } from './role-create-form';

/** 行操作（统一 RowActions 三点菜单）:按按钮权限显隐(admins:update/delete);
 * 删除对全角色开放——唯一硬闸 = 挂载管理员(预检禁用+计数提示,后端 role_in_use 兜底) */
function RoleRowActions({
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

/** 角色清单（通用 DataTable;分页/搜索在页面层 ListPage） */
export function RolesContent({
  roles,
  tree,
  canUpdate,
  canDelete,
}: {
  roles: RoleRowWithGrants[];
  tree: PermissionNode[];
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations('roles');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [deleting, setDeleting] = useState<RoleRowWithGrants | null>(null);

  const columns: DataTableColumn<RoleRowWithGrants>[] = [
    {
      key: 'code',
      header: t('code'),
      render: (r) => <span className="font-mono text-sm">{r.code}</span>,
    },
    {
      key: 'name',
      header: tc('name'),
      render: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: 'flags',
      header: t('flags'),
      render: (r) => (
        <div className="flex gap-1">
          {r.isSuper ? <Badge>{t('superFlag')}</Badge> : null}
          {r.isBuiltin ? <Badge variant="secondary">{t('builtinFlag')}</Badge> : null}
          {r.status === 1 ? <Badge variant="destructive">{tc('disabled')}</Badge> : null}
        </div>
      ),
    },
    { key: 'adminCount', header: t('adminCount'), render: (r) => r.adminCount },
    {
      key: 'codes',
      header: t('grants'),
      render: (r) => (
        <span className="text-sm text-muted-foreground">
          {r.isSuper ? t('implicitAll') : `${r.codes.length}`}
        </span>
      ),
    },
    {
      key: 'actions',
      header: tc('actions'),
      render: (r) =>
        r.isSuper ? (
          <span className="text-xs text-muted-foreground">{t('superLocked')}</span>
        ) : (
          <RoleRowActions
            role={r}
            nodes={tree}
            canUpdate={canUpdate}
            canDelete={canDelete}
            onDelete={setDeleting}
          />
        ),
    },
  ];

  const onConfirm = async () => {
    if (deleting == null) return;
    const res = await deleteRoleAction(deleting.id);
    if (res.errorKey) toast.error(t(`errors.${res.errorKey}`));
    else notify(res, t('actionFailed'), t('deleted'));
    setDeleting(null);
  };

  return (
    <div className="space-y-3">
      <DataTable rowKey={(r) => r.id} rows={roles} columns={columns} empty={t('empty')} />
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
