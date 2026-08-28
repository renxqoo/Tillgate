import { requirePermission } from '@/server/get-admin';
import { NetworkIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { fetchAdminList } from '@/server/admin-list';
import type { AdminProviderRow } from '@tillgate/api-client';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

import {
  ChannelsTable,
  CreateChannelDialog,
  ImportChannelsDialog,
} from '@/features/channels/channels-content';
import type { AdminChannelRow, ProviderOption } from '@tillgate/api-client';

import { ViewTabs } from './view-tabs';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ChannelsPage({ searchParams }: PageProps) {
  await requirePermission('catalog:read');
  const sp = await searchParams;
  const t = await getTranslations('channels');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const view = sp.view === 'deleted' ? ('deleted' as const) : ('active' as const);
  const {
    rows: channels,
    total,
    error,
  } = await fetchAdminList<AdminChannelRow>('/v1/channels', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q, ...(view === 'deleted' ? { view } : {}) },
  });
  const providers: ProviderOption[] = [];
  if (view === 'active') {
    try {
      const p = await fetchAdminList<AdminProviderRow>('/v1/providers', {
        page: 1,
        pageSize: 100,
      });
      for (const x of p.rows) {
        providers.push({
          id: x.id,
          name: x.name,
          baseUrl: x.baseUrl,
          protocol: x.protocol,
          status: x.status,
        });
      }
    } catch {
      // providers 失败不阻塞
    }
  }

  return (
    <ListPage
      title={t('title')}
      icon={<NetworkIcon className="size-5 text-muted-foreground" />}
      description={view === 'deleted' ? t('recycleHint') : t('description')}
      total={total}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined, view: sp.view }}
      filters={<ViewTabs active={view} labels={{ all: t('viewAll'), deleted: t('viewDeleted') }} />}
      actions={
        view === 'active' ? (
          <>
            <ImportChannelsDialog />
            <CreateChannelDialog providers={providers} />
          </>
        ) : undefined
      }
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <ChannelsTable channels={channels} providers={providers} />
    </ListPage>
  );
}
