import { requirePermission } from '@/server/get-admin';
import { CpuIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fetchAdminList } from '@/server/admin-list';
import type { AdminChannelRow } from '@tillgate/api-client';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

import { CreateModelDialog, ModelsTable } from '@/features/models/models-content';
import type { ChannelOption, AdminModelRow } from '@tillgate/api-client';

import { ViewTabs } from './view-tabs';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ModelsPage({ searchParams }: PageProps) {
  await requirePermission('catalog:read');
  const sp = await searchParams;
  const t = await getTranslations('models');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const view = sp.view === 'deleted' ? ('deleted' as const) : ('active' as const);
  const {
    rows: models,
    total,
    error,
  } = await fetchAdminList<AdminModelRow>('/v1/models', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q, ...(view === 'deleted' ? { view } : {}) },
  });
  let channels: ChannelOption[] = [];
  if (view === 'active') {
    try {
      const c = await fetchAdminList<AdminChannelRow>('/v1/channels', {
        page: 1,
        pageSize: 100,
      });
      channels = c.rows.map((x) => ({ id: x.id, name: x.name, providerName: x.providerName }));
    } catch {
      // channels 失败不阻塞
    }
  }

  return (
    <ListPage
      title={t('title')}
      icon={<CpuIcon className="size-5 text-muted-foreground" />}
      description={view === 'deleted' ? t('recycleHint') : t('description')}
      total={total}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined, view: sp.view }}
      filters={<ViewTabs active={view} labels={{ all: t('viewAll'), deleted: t('viewDeleted') }} />}
      actions={view === 'active' ? <CreateModelDialog /> : undefined}
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <ModelsTable models={models} channels={channels} />
    </ListPage>
  );
}
