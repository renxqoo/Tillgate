import { CpuIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { fetchAdminList } from '@/server/admin-list';
import type { AdminChannelRow } from '@tokenlens/api-client';
import { ListPage } from '@/components/list-page';
import { parseListSearchParams } from '@/lib/list-query';

import { CreateModelDialog, ModelsTable } from '@/features/models/models-content';
import type { ChannelOption, AdminModelRow } from '@tokenlens/api-client';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** 视图 tab：在册（缺省）/ 回收站（view=deleted）；Link 导航，样式与模型市场源 tab 同款 */
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
        href="/dashboard/models"
        className={`rounded-md px-2 py-1 ${
          active === 'active'
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:bg-muted/70'
        }`}
      >
        {labels.all}
      </Link>
      <Link
        href="/dashboard/models?view=deleted"
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

export default async function ModelsPage({ searchParams }: PageProps) {
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
