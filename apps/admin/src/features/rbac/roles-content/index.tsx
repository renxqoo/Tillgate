'use client';

// 角色清单：DataTable 列定义 + 行操作（编辑/删除）+ 删除确认
// （共享表单弹窗在 role-form-dialog，授权树在 grant-tree）

import type { PermissionNode } from '@tillgate/api-client';
import { Badge, ConfirmDialog } from '@tillgate/ui';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { DataTableColumn } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { useActionResult } from '@/components/action-toast';
import { deleteRoleAction } from '@/server/rbac-actions';
import type { RoleRowWithGrants } from './role-form-dialog';
import { RoleRowActions } from './role-row-actions';

export { RoleCreateForm } from './role-create-form';

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
