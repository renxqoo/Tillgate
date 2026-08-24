import { ShieldCheckIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { ApiError, type AppRow } from '@tillgate/api-client';

import { AppsTable, CreateAppDialog } from '@/features/applications/apps-content';
import { ListPage } from '@/features/shared/list-page';
import { parseListSearchParams } from '@/server/list-query';
import { createClientApi } from '@/server/api';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AppsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations('apps');
  const { page } = parseListSearchParams(sp);
  const api = createClientApi();
  await requireMe(api);

  let rows: AppRow[] = [];
  let total = 0;
  let error: string | null = null;
  try {
    const result = await api.list<AppRow>('/v1/apps', { page, pageSize: PAGE_SIZE });
    rows = result.rows;
    total = result.total;
  } catch (e) {
    error = e instanceof ApiError ? e.message : null;
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <ListPage
        title={t('title')}
        icon={<ShieldCheckIcon className="size-5 text-muted-foreground" />}
        description={t('description')}
        total={total}
        totalUnit={t('totalUnit')}
        searchParams={{ page: page > 1 ? String(page) : undefined }}
        actions={<CreateAppDialog />}
        error={error}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <AppsTable apps={rows} />
      </ListPage>
    </div>
  );
}
