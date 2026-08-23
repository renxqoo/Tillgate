import { ServerIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fetchAdminList } from '@/server/admin-list';
import { adminApi } from '@/server/admin-api';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

import { CreateProviderDialog, ProvidersTable } from '@/features/channels/providers-content';
import type { AdminProviderRow } from '@tokenlens/api-client';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ProvidersPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations('providers');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const { rows, total, error } = await fetchAdminList<AdminProviderRow>('/v1/providers', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });
  // P6:词表单一真相 = admin-api /v1/vendor-catalog（ai 根出口装配;过渡快照已删除）。
  // admin-api 不可达时降级空词表——表单仍可提交,后端 control-plane 词表校验是最终防线。
  const vendorCatalog = await adminApi()
    .get<{ protocols: string[]; vendors: string[] }>('/v1/vendor-catalog')
    .catch(() => ({ protocols: [], vendors: [] }));

  return (
    <ListPage
      title={t('title')}
      icon={<ServerIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
      actions={
        <CreateProviderDialog
          protocols={vendorCatalog.protocols}
          vendors={vendorCatalog.vendors}
        />
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
