import { NetworkIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

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

export default async function ChannelsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations('channels');
  const { q, page, sortBy, order } = parseListSearchParams(sp);
  const {
    rows: channels,
    total,
    error,
  } = await fetchAdminList<AdminChannelRow>('/v1/channels', {
    page,
    pageSize: PAGE_SIZE,
    sortBy,
    order,
    extra: { q },
  });
  const providers: ProviderOption[] = [];
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

  return (
    <ListPage
      title={t('title')}
      icon={<NetworkIcon className="size-5 text-muted-foreground" />}
      description={t('description')}
      total={total}
      searchPlaceholder={t('searchPlaceholder')}
      q={q}
      searchParams={{ q, sort_by: sortBy, order: sortBy ? order : undefined }}
      actions={
        <>
          <ImportChannelsDialog />
          <CreateChannelDialog providers={providers} />
        </>
      }
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <ChannelsTable channels={channels} providers={providers} />
    </ListPage>
  );
}
