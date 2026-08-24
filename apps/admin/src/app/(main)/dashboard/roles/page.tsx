import { requirePermission } from '@/server/get-admin';
import { UsersIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { adminApi } from '@/server/admin-api';
import { ListPage } from '@/components/list-page';

import { RolesContent } from '@/features/rbac/roles-content';

export const dynamic = 'force-dynamic';

export default async function RolesPage() {
  await requirePermission('admins:read');
  const t = await getTranslations('roles');
  const tc = await getTranslations('common');
  const roles = await adminApi()
    .listRoles({ pageSize: 100 })
    .catch(() => null);
  const tree = await adminApi()
    .permissionTree()
    .catch(() => []);

  return (
    <ListPage
      title={t('title')}
      icon={<UsersIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      error={roles == null ? tc('loadFailed') : null}
    >
      <RolesContent roles={roles?.rows ?? []} total={roles?.total ?? 0} tree={tree} />
    </ListPage>
  );
}
