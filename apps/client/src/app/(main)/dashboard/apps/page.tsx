import { ShieldCheckIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { ApiError, type AppRow } from '@tillgate/api-client';

import { CreateAppDialog } from '@/features/applications/create-app-dialog';
import { AppsTable } from '@/features/applications/apps-content';
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
  let loadError: string | null = null;
  try {
    const result = await api.list<AppRow>('/v1/apps', { page, pageSize: PAGE_SIZE });
    // catch 形参按 catch-error-name 规则命名为 error，外层改名为 loadError：原写法
    // 赋给了 catch 参数导致外层恒为 null，加载失败提示永不上屏——真实 bug 一并修复
    ({ rows, total } = result);
  } catch (error) {
    loadError = error instanceof ApiError ? error.message : null;
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
        error={loadError}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <AppsTable apps={rows} />
      </ListPage>
    </div>
  );
}
