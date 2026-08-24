import { requirePermission } from '@/server/get-admin';
import { ServerIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { fetchAdminList } from '@/server/admin-list';
import { adminApi } from '@/server/admin-api';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

import { CreateProviderDialog, ProvidersTable } from '@/features/channels/providers-content';
import type { AdminProviderRow } from '@tillgate/api-client';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** 视图 tab：在册（缺省）/ 回收站（view=deleted）；Link 导航，样式与模型映射视图 tab 同款 */
function ViewTabs({
  active,
  labels,
}: {
  active: 'active' | 'deleted';
  labels: { all: string; deleted: string };
}) {
  return (
    <span className="flex gap-1 text-xs">
      <Link
        href="/dashboard/providers"
        className={`rounded-md px-2 py-1 ${
          active === 'active'
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:bg-muted/70'
        }`}
      >
        {labels.all}
      </Link>
      <Link
        href="/dashboard/providers?view=deleted"
        className={`rounded-md px-2 py-1 ${
          active === 'deleted'
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:bg-muted/70'
        }`}
      >
        {labels.deleted}
      </Link>
    </span>
  );
}

export default async function ProvidersPage({ searchParams }: PageProps) {
  await requirePermission('catalog:read');
  const sp = await searchParams;
  const t = await getTranslations('providers');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const view = sp.view === 'deleted' ? ('deleted' as const) : ('active' as const);
  const { rows, total, error } = await fetchAdminList<AdminProviderRow>('/v1/providers', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q, ...(view === 'deleted' ? { view } : {}) },
  });
  // P6:词表单一真相 = admin-api /v1/vendor-catalog（ai 根出口装配;过渡快照已删除）。
  // admin-api 不可达时降级空词表——表单仍可提交,后端 control-plane 词表校验是最终防线。
  const vendorCatalog =
    view === 'active'
      ? await adminApi()
          .get<{ protocols: string[]; vendors: string[] }>('/v1/vendor-catalog')
          .catch(() => ({ protocols: [], vendors: [] }))
      : { protocols: [], vendors: [] };

  return (
    <ListPage
      title={t('title')}
      icon={<ServerIcon className="size-5 text-muted-foreground" />}
      description={view === 'deleted' ? t('recycleHint') : t('description')}
      total={total}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined, view: sp.view }}
      filters={<ViewTabs active={view} labels={{ all: t('viewAll'), deleted: t('viewDeleted') }} />}
      actions={
        view === 'active' ? (
          <CreateProviderDialog
            protocols={vendorCatalog.protocols}
            vendors={vendorCatalog.vendors}
          />
        ) : undefined
      }
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <ProvidersTable
        providers={rows}
        protocols={vendorCatalog.protocols}
        vendors={vendorCatalog.vendors}
      />
    </ListPage>
  );
}
