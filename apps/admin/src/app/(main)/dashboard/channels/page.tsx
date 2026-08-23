import { NetworkIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { fetchAdminList } from '@/server/admin-list';
import type { AdminProviderRow } from '@tokenlens/api-client';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

import {
  ChannelsTable,
  CreateChannelDialog,
  ImportChannelsDialog,
} from '@/features/channels/channels-content';
import type { AdminChannelRow, ProviderOption } from '@tokenlens/api-client';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** 视图 tab：在册（缺省）/ 回收站（view=deleted）；Link 导航，样式与模型映射/供应商视图 tab 同款 */
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
        href="/dashboard/channels"
        className={`rounded-md px-2 py-1 ${
          active === 'active'
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:bg-muted/70'
        }`}
      >
        {labels.all}
      </Link>
      <Link
        href="/dashboard/channels?view=deleted"
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

export default async function ChannelsPage({ searchParams }: PageProps) {
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
