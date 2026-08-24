import { hasPerm, requirePermission } from '@/server/get-admin';
import { PlugIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { adminApi } from '@/server/admin-api';
import { ListPage } from '@/components/list-page';

import { BindingsContent, CreateBindingForm } from '@/features/rbac/bindings-content';

export const dynamic = 'force-dynamic';

export default async function EndpointsPage() {
  const me = await requirePermission('admins:read');
  const t = await getTranslations('endpoints');
  const tc = await getTranslations('common');

  const bindings = await adminApi()
    .listEndpointBindings()
    .catch(() => null);
  const tree = await adminApi()
    .permissionTree()
    .catch(() => []);

  return (
    <ListPage
      title={t('title')}
      icon={<PlugIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={bindings?.length}
      actions={hasPerm(me, 'admins:create') ? <CreateBindingForm nodes={tree} /> : null}
      error={bindings == null ? tc('loadFailed') : null}
    >
      <BindingsContent
        bindings={bindings ?? []}
        nodes={tree}
        canUpdate={hasPerm(me, 'admins:update')}
        canDelete={hasPerm(me, 'admins:delete')}
      />
    </ListPage>
  );
}
