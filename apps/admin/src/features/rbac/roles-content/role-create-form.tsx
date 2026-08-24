'use client';

// 新建角色入口（页头 actions 插槽;表单复用 role-form-dialog）

import type { PermissionNode } from '@tillgate/api-client';
import { Button } from '@tillgate/ui';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { RoleFormDialog } from './role-form-dialog';

/** 新建角色入口（页头 actions 插槽） */
export function RoleCreateForm({ nodes }: { nodes: PermissionNode[] }) {
  const t = useTranslations('roles');
  return (
    <RoleFormDialog
      nodes={nodes}
      trigger={
        <Button size="sm">
          <PlusIcon className="size-4" />
          {t('create')}
        </Button>
      }
    />
  );
}
