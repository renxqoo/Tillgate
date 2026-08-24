import { hasPerm, requirePermission } from '@/server/get-admin';
import { ListTreeIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { adminApi } from '@/server/admin-api';
import { ListPage } from '@/components/list-page';

import { CreateNodeForm, PermissionsContent } from '@/features/rbac/permissions-content';

export const dynamic = 'force-dynamic';

export default async function PermissionsPage() {
  const me = await requirePermission('admins:read');
  const t = await getTranslations('permissions');
  const tc = await getTranslations('common');
  const tree = await adminApi()
    .permissionTree()
    .catch(() => null);

  return (
    <ListPage
      title={t('title')}
      icon={<ListTreeIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={(tree ?? []).length}
      actions={hasPerm(me, 'admins:create') ? <CreateNodeForm nodes={tree ?? []} /> : null}
      error={tree == null ? tc('loadFailed') : null}
    >
      <PermissionsContent
        nodes={tree ?? []}
        canUpdate={hasPerm(me, 'admins:update')}
        canDelete={hasPerm(me, 'admins:delete')}
      />
    </ListPage>
  );
}
