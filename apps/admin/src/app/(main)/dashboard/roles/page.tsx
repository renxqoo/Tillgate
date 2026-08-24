import { hasPerm, requirePermission } from '@/server/get-admin';
import { UsersIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { adminApi } from '@/server/admin-api';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

import { RoleCreateForm, RolesContent } from '@/features/rbac/roles-content';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RolesPage({ searchParams }: PageProps) {
  const me = await requirePermission('admins:read');
  const sp = await searchParams;
  const t = await getTranslations('roles');
  const tc = await getTranslations('common');
  const { q, page } = parseListSearchParams(sp);

  const roles = await adminApi()
    .listRoles({ page, pageSize: PAGE_SIZE, ...(q ? { q } : {}) })
    .catch(() => null);
  const tree = await adminApi()
    .permissionTree()
    .catch(() => []);

  return (
    <ListPage
      title={t('title')}
      icon={<UsersIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={roles?.total ?? 0}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q }}
      actions={hasPerm(me, 'admins:create') ? <RoleCreateForm nodes={tree} /> : null}
      error={roles == null ? tc('loadFailed') : null}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <RolesContent
        roles={roles?.rows ?? []}
        tree={tree}
        canUpdate={hasPerm(me, 'admins:update')}
        canDelete={hasPerm(me, 'admins:delete')}
      />
    </ListPage>
  );
}
