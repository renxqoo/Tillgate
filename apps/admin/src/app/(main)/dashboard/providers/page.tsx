import { ServerIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { SUPPORTED_PROTOCOLS, VENDOR_PROFILE_NAMES } from '@/config/protocols';

import { fetchAdminList } from '@/server/admin-list';
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
        <CreateProviderDialog protocols={SUPPORTED_PROTOCOLS} vendors={VENDOR_PROFILE_NAMES} />
      }
      error={error}
      page={page}
      pageSize={PAGE_SIZE}
    >
      <ProvidersTable
        providers={rows}
        protocols={SUPPORTED_PROTOCOLS}
        vendors={VENDOR_PROFILE_NAMES}
      />
    </ListPage>
  );
}
